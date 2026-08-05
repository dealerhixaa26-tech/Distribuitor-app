import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { QUEUE_NAMES } from '@hixaa/contracts';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { MailService } from '../infrastructure/mail/mail.service';
import { OutboxDispatcherService } from '../infrastructure/outbox/outbox-dispatcher.service';
import { BackupService } from '../modules/backup/backup.service';
import { DatabaseBackupService } from '../modules/backup/database-backup.service';
import { JobHeartbeatService, STALE_AFTER } from '../modules/health/job-heartbeat.service';

/**
 * The Sheets backup, scheduled and on demand.
 *
 * Worker-only: the API never calls the Sheets API (docs/07 §2). The manual
 * endpoint enqueues onto this queue and returns 202.
 */
@Processor(QUEUE_NAMES.SHEETS_SYNC)
export class BackupProcessor extends WorkerHost {
  constructor(
    private readonly backup: BackupService,
    private readonly database: DatabaseBackupService,
    private readonly mail: MailService,
    private readonly config: AppConfigService,
    private readonly heartbeat: JobHeartbeatService,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(BackupProcessor.name);
  }

  /**
   * The nightly `pg_dump` — the REAL disaster-recovery mechanism (ADR-0024).
   *
   * 01:30 IST: before the 02:00 Sheets sync so the two do not contend, and
   * before the 03:00 retention purge so the backup captures the rows that purge
   * is about to delete.
   */
  @Cron(process.env.BACKUP_CRON || '30 1 * * *', { timeZone: 'Asia/Kolkata' })
  async databaseBackup(): Promise<void> {
    if (!this.config.queue.workerEnabled || !this.config.backup.enabled) return;

    await OutboxDispatcherService.asSystem('database-backup', async () => {
      await this.heartbeat.track('database-backup', STALE_AFTER.DAILY, async () => {
      const result = await this.database.run();

      // Reported on success too. A nightly green line is what makes its absence
      // noticeable; a report only on failure is indistinguishable from silence.
      await this.mail.sendOps('backup-report', {
        status: result.status,
        target: result.file
          ? `pg_dump → ${result.file} (${result.encryptedBytes ?? 0} bytes encrypted, ` +
            `${result.retainedFiles ?? 0} retained)`
          : 'pg_dump',
        sizeBytes: result.encryptedBytes,
        durationSeconds: result.durationSeconds,
        error: result.error,
      });
      // A backup job that RAN but produced nothing is a failed backup, and the
      // heartbeat must say so rather than recording a clean run.
      if (result.status !== 'success') throw new Error(result.error ?? 'backup failed');
      });
    });
  }

  /**
   * The monthly restore rehearsal.
   *
   * ADR-0024: a backup is proven by restoring it, not by an exit code. This
   * restores the newest encrypted dump into a scratch database and compares row
   * counts table by table — so a backup chain that quietly stops being
   * restorable fails loudly, instead of staying green until someone needs it.
   */
  @Cron(process.env.BACKUP_REHEARSAL_CRON || '0 4 1 * *', { timeZone: 'Asia/Kolkata' })
  async rehearseRestore(): Promise<void> {
    if (!this.config.queue.workerEnabled || !this.config.backup.enabled) return;

    await OutboxDispatcherService.asSystem('backup-rehearsal', async () => {
      await this.heartbeat.track('backup-rehearsal', STALE_AFTER.MONTHLY, async () => {
      const result = await this.database.rehearse();

      await this.mail.sendOps('backup-report', {
        status: result.status,
        target:
          `RESTORE REHEARSAL — ${result.restoredTables}/${result.sourceTables} tables, ` +
          `${result.restoredRows}/${result.sourceRows} rows`,
        durationSeconds: result.durationSeconds,
        error:
          result.error ??
          (result.mismatches.length ? `Mismatches: ${result.mismatches.join(' · ')}` : undefined),
      });

      if (result.status === 'success') {
        this.logger.info(
          { tables: result.restoredTables, rows: result.restoredRows },
          'Restore rehearsal passed — the backup is provably restorable',
        );
      } else {
        throw new Error(result.error ?? (result.mismatches.join(' · ') || 'rehearsal failed'));
      }
      });
    });
  }

  /** Manual runs, enqueued by `POST /backup/sheets/sync`. */
  async process(job: Job<{ triggeredById?: string }>): Promise<void> {
    await OutboxDispatcherService.asSystem('sheets-backup-manual', async () => {
      await this.run({ triggeredById: job.data?.triggeredById, isScheduled: false });
    });
  }

  /**
   * The nightly run, 02:00 IST by default (`SHEETS_SYNC_CRON`).
   *
   * ⚠️ The cron expression is read from configuration but @Cron needs it at
   * decoration time, so it is applied through `CronExpression`-style string
   * substitution at module load. A change to SHEETS_SYNC_CRON takes effect on
   * restart, not live — stated because a setting that silently does not apply
   * is worse than a constant.
   */
  @Cron(process.env.SHEETS_SYNC_CRON || '0 2 * * *', { timeZone: 'Asia/Kolkata' })
  async scheduled(): Promise<void> {
    if (!this.config.queue.workerEnabled) return;

    await OutboxDispatcherService.asSystem('sheets-backup-scheduled', async () => {
      await this.heartbeat.track('sheets-backup', STALE_AFTER.DAILY, () =>
        this.run({ isScheduled: true }),
      );
    });
  }

  private async run(options: { triggeredById?: string; isScheduled: boolean }): Promise<void> {
    try {
      const result = await this.backup.runAll(options);

      const rows = result.entities.reduce((n, e) => n + e.rowsProcessed, 0);
      const failed = result.entities.filter((e) => e.status === 'FAILED');

      /*
       * Reported on every outcome, not only failure.
       *
       * A backup that stops reporting looks exactly like a backup that keeps
       * succeeding, and that equivalence is what makes a silent backup
       * dangerous (docs/07 §2). A nightly success line is what makes its
       * ABSENCE noticeable.
       */
      await this.mail.sendOps('backup-report', {
        status:
          result.status === 'SUCCESS' ? 'success' : result.status === 'PARTIAL' ? 'partial' : 'failure',
        target: `Google Sheets (${rows} rows across ${result.entities.length} entities)`,
        durationSeconds: Math.round(result.durationMs / 1000),
        error: failed.length
          ? failed.map((f) => `${f.entity}: ${f.error ?? 'unknown'}`).join(' · ')
          : undefined,
      });
    } catch (error) {
      this.logger.error({ err: error }, 'Sheets backup run threw');
      await this.mail.sendOps('backup-report', {
        status: 'failure',
        target: 'Google Sheets',
        durationSeconds: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
