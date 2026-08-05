import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { QUEUE_NAMES } from '@hixaa/contracts';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { MailService } from '../infrastructure/mail/mail.service';
import { OutboxDispatcherService } from '../infrastructure/outbox/outbox-dispatcher.service';
import { BackupService } from '../modules/backup/backup.service';

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
    private readonly mail: MailService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(BackupProcessor.name);
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
      await this.run({ isScheduled: true });
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
