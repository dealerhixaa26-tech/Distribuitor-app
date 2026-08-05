import { Injectable } from '@nestjs/common';
import { DOMAIN_EVENTS } from '@hixaa/contracts';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';
import { ClockService } from '../../common/utils/clock.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { SheetsPort, type SheetLocation } from '../../infrastructure/sheets/sheets.port';
import { BACKUP_ENTITIES, type BackupEntity } from './backup-entities';

export interface EntityResult {
  entity: string;
  status: 'SUCCESS' | 'FAILED';
  rowsProcessed: number;
  rowsExpected: number;
  error?: string;
}

export interface BackupRunResult {
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  entities: EntityResult[];
  durationMs: number;
}

@Injectable()
export class BackupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sheets: SheetsPort,
    private readonly config: AppConfigService,
    private readonly outbox: OutboxService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BackupService.name);
  }

  /**
   * Public so verification and the health check resolve a location the SAME way
   * the export does. A script that computed the target itself could pass while
   * the real job wrote somewhere else.
   */
  spreadsheetFor(entity: BackupEntity): string {
    const { spreadsheetIdPrimary, spreadsheetIdTransactions } = this.config.sheets;
    // Sharded by entity because Sheets caps at 10M cells and a single book
    // cannot hold the stated scale — docs/07 §2's "honest limitation".
    const id = entity.shard === 'PRIMARY' ? spreadsheetIdPrimary : spreadsheetIdTransactions;
    // The local adapter needs a stable book name, not a Google id, so a blank
    // configuration still produces a usable on-disk layout.
    return id || (entity.shard === 'PRIMARY' ? 'hixaa-masters' : 'hixaa-transactions');
  }

  /** Runs every entity. One entity failing does not abandon the others. */
  async runAll(options: { triggeredById?: string; isScheduled?: boolean } = {}): Promise<BackupRunResult> {
    const startedAt = this.clock.nowMs();
    const entities: EntityResult[] = [];

    for (const entity of BACKUP_ENTITIES) {
      entities.push(await this.runEntity(entity, options));
    }

    const failed = entities.filter((e) => e.status === 'FAILED');
    const status =
      failed.length === 0 ? 'SUCCESS' : failed.length === entities.length ? 'FAILED' : 'PARTIAL';

    const result: BackupRunResult = { status, entities, durationMs: this.clock.nowMs() - startedAt };

    if (status !== 'SUCCESS') {
      // A backup that silently stops is worse than no backup, because it
      // manufactures confidence (docs/07 §2). Partial counts as a failure worth
      // waking someone for.
      this.logger.error({ status, failed: failed.map((f) => f.entity) }, 'Sheets backup not clean');
    } else {
      this.logger.info(
        { durationMs: result.durationMs, rows: entities.reduce((n, e) => n + e.rowsProcessed, 0) },
        'Sheets backup complete',
      );
    }

    return result;
  }

  /**
   * One entity, chunked and checkpointed.
   *
   * Writes to a STAGING sheet and swaps at the end, so a run that dies half way
   * never leaves a truncated sheet that looks like a complete backup.
   */
  async runEntity(
    entity: BackupEntity,
    options: { triggeredById?: string; isScheduled?: boolean } = {},
  ): Promise<EntityResult> {
    const spreadsheetId = this.spreadsheetFor(entity);
    const target: SheetLocation = { spreadsheetId, title: entity.name };
    const staging: SheetLocation = { spreadsheetId, title: `${entity.name}__staging` };
    const batchSize = this.config.sheets.batchSize;

    // Counted BEFORE the run. This number is what makes an empty export
    // detectable instead of indistinguishable from an empty table.
    const rowsExpected = await entity.count(this.prisma);

    /*
     * `requestCount()` is the adapter's RUNNING TOTAL for the process, so the
     * per-job figure is a delta. Recording it raw made every SyncJob row report
     * the cumulative count — the first real Google run produced 112, 120, 128,
     * 136, 144, 152, 160 across six entities, which reads like the last entity
     * cost 160 requests when it cost 8. A quota number nobody can trust per run
     * is worse than none, because it is the number you would reach for when
     * deciding whether a 429 was your own fault.
     */
    const requestsBefore = this.sheets.requestCount();
    const requestsUsed = (): number => this.sheets.requestCount() - requestsBefore;

    const job = await this.prisma.db.syncJob.create({
      data: {
        entity: entity.name,
        direction: 'EXPORT',
        status: 'RUNNING',
        rowsExpected,
        spreadsheetId,
        sheetTitle: entity.name,
        isDryRun: false,
        isScheduled: options.isScheduled ?? false,
        triggeredById: options.triggeredById ?? null,
        startedAt: this.clock.now(),
      },
      select: { id: true },
    });

    let rowsProcessed = 0;
    let batches = 0;

    try {
      // A leftover staging sheet means a previous run died; start clean.
      await this.sheets.deleteSheet(staging);
      await this.sheets.ensureSheet(staging);
      await this.sheets.appendRows(staging, [entity.header]);

      let cursor: string | undefined;
      for (;;) {
        const { rows, nextCursor } = await entity.page(this.prisma, cursor, batchSize);
        if (rows.length === 0) break;

        await this.sheets.appendRows(staging, rows);
        rowsProcessed += rows.length;
        batches++;
        cursor = nextCursor;

        // Persisted after EVERY batch, so a failure at row 400,000 resumes from
        // 400,000 rather than restarting.
        await this.prisma.db.syncJob.update({
          where: { id: job.id },
          data: { checkpointCursor: cursor ?? null, rowsProcessed, batchesWritten: batches },
        });

        if (!nextCursor) break;
      }

      /*
       * THE GUARD THIS PHASE EXISTS TO ADD.
       *
       * Exporting zero rows from a non-empty table is not an empty backup, it
       * is a BROKEN one — and until ADR-0021 it was the exact thing that would
       * have happened here, silently: four of these six entities are scoped
       * models, and every background job was reading `id IN ()`. The nightly
       * reconciliation spent three phases reporting "clean" over zero rows.
       *
       * So this is a failure, not a warning.
       */
      if (rowsExpected > 0 && rowsProcessed === 0) {
        throw new Error(
          `Exported 0 rows for ${entity.name} but the table holds ${rowsExpected}. ` +
            `Refusing to publish an empty backup over a good one.`,
        );
      }

      await this.sheets.swapSheet(staging, target);

      await this.prisma.db.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'SUCCESS',
          rowsProcessed,
          batchesWritten: batches,
          completedAt: this.clock.now(),
          durationMs: this.clock.nowMs() - (await this.startedMs(job.id)),
          apiRequests: requestsUsed(),
        },
      });

      return { entity: entity.name, status: 'SUCCESS', rowsProcessed, rowsExpected };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Leave the live sheet untouched and bin the half-written staging copy.
      await this.sheets.deleteSheet(staging).catch(() => undefined);

      await this.prisma.db.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          rowsProcessed,
          batchesWritten: batches,
          completedAt: this.clock.now(),
          error: message.slice(0, 1000),
          apiRequests: requestsUsed(),
        },
      });

      // Routed to the ops channel by EVENT_QUEUE_ROUTING. Since ADR-0022 this
      // leaves an EmailLog row even when MAIL_OPS_TO is unset.
      await this.prisma.transaction(async (tx) => {
        await this.outbox.emit(
          tx,
          DOMAIN_EVENTS.SHEETS_SYNC_FAILED,
          { type: 'SyncJob', id: job.id },
          { entity: entity.name, rowsProcessed: String(rowsProcessed), error: message },
        );
      });

      this.logger.error({ err: error, entity: entity.name, rowsProcessed }, 'Entity backup failed');
      return { entity: entity.name, status: 'FAILED', rowsProcessed, rowsExpected, error: message };
    }
  }

  private async startedMs(jobId: string): Promise<number> {
    const job = await this.prisma.db.syncJob.findUnique({
      where: { id: jobId },
      select: { startedAt: true },
    });
    return job?.startedAt?.getTime() ?? this.clock.nowMs();
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  async listJobs(limit: number) {
    return this.prisma.db.syncJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        entity: true,
        direction: true,
        status: true,
        rowsProcessed: true,
        rowsExpected: true,
        isDryRun: true,
        startedAt: true,
        completedAt: true,
        durationMs: true,
        error: true,
        apiRequests: true,
        isScheduled: true,
        createdAt: true,
      },
    });
  }
}
