import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain.error';
import { AppConfigService } from '../../config/app-config.service';
import { ClockService } from '../../common/utils/clock.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { SheetsPort, type SheetLocation } from '../../infrastructure/sheets/sheets.port';
import { BACKUP_ENTITIES, type BackupEntity } from './backup-entities';

/** A bounded sample; a diff report must not become a second copy of the data. */
const SAMPLE_LIMIT = 20;

export interface RestoreDiff {
  entity: string;
  rowsInSheet: number;
  rowsInDatabase: number;
  /** In the sheet, absent from the database — a restore would INSERT these. */
  missingInDatabase: number;
  /** In both, with differing values — a restore would OVERWRITE these. */
  differing: number;
  /** In the database, absent from the sheet — a restore would NOT delete them. */
  onlyInDatabase: number;
  samples: {
    missingInDatabase: string[];
    differing: Array<{ id: string; column: string; sheet: string; database: string }>;
    onlyInDatabase: string[];
  };
}

@Injectable()
export class RestoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sheets: SheetsPort,
    private readonly config: AppConfigService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RestoreService.name);
  }

  private entityOrThrow(name: string): BackupEntity {
    const entity = BACKUP_ENTITIES.find((e) => e.name === name);
    if (!entity) {
      throw new ValidationError(
        `Unknown backup entity "${name}". Expected one of: ` +
          BACKUP_ENTITIES.map((e) => e.name).join(', '),
      );
    }
    return entity;
  }

  private spreadsheetFor(entity: BackupEntity): string {
    const { spreadsheetIdPrimary, spreadsheetIdTransactions } = this.config.sheets;
    const id = entity.shard === 'PRIMARY' ? spreadsheetIdPrimary : spreadsheetIdTransactions;
    return id || (entity.shard === 'PRIMARY' ? 'hixaa-masters' : 'hixaa-transactions');
  }

  /**
   * Compares a backup sheet against the live table and reports the difference.
   *
   * This is the ONLY thing a restore request does unless it is explicitly
   * confirmed. Restores are rare, high-stakes and irreversible, and they should
   * feel that way (`docs/07` §2).
   *
   * The diff is computed entirely in memory against the sheet's own id column,
   * and never writes. It is safe to run at any time.
   */
  async dryRun(entityName: string, triggeredById?: string): Promise<RestoreDiff> {
    const entity = this.entityOrThrow(entityName);
    const spreadsheetId = this.spreadsheetFor(entity);
    const location: SheetLocation = { spreadsheetId, title: entity.name };

    const job = await this.prisma.db.syncJob.create({
      data: {
        entity: entity.name,
        direction: 'RESTORE',
        status: 'RUNNING',
        isDryRun: true,
        spreadsheetId,
        sheetTitle: entity.name,
        triggeredById: triggeredById ?? null,
        startedAt: this.clock.now(),
      },
      select: { id: true },
    });

    try {
      const raw = await this.sheets.readRows(location);
      if (raw.length === 0) {
        throw new NotFoundError('Backup sheet', `${spreadsheetId}/${entity.name}`);
      }

      const [header, ...body] = raw;
      if (!header || header[0] !== 'id') {
        throw new ValidationError(
          `Backup sheet for ${entity.name} has no recognisable header; refusing to diff it.`,
        );
      }

      const sheetById = new Map<string, string[]>();
      for (const row of body) {
        const id = row[0];
        if (id) sheetById.set(id, row);
      }

      // The live side, read through the SAME mappers the export uses, so a
      // difference means the data differs — not that two code paths formatted
      // the same value differently.
      const dbById = new Map<string, string[]>();
      let cursor: string | undefined;
      for (;;) {
        const { rows, nextCursor } = await entity.page(this.prisma, cursor, 1000);
        if (rows.length === 0) break;
        for (const row of rows) if (row[0]) dbById.set(row[0], row);
        cursor = nextCursor;
        if (!nextCursor) break;
      }

      const missing: string[] = [];
      const differing: RestoreDiff['samples']['differing'] = [];
      let differingCount = 0;

      for (const [id, sheetRow] of sheetById) {
        const dbRow = dbById.get(id);
        if (!dbRow) {
          missing.push(id);
          continue;
        }
        for (let col = 0; col < header.length; col++) {
          const a = sheetRow[col] ?? '';
          const b = dbRow[col] ?? '';
          if (a !== b) {
            differingCount++;
            if (differing.length < SAMPLE_LIMIT) {
              differing.push({ id, column: header[col] ?? String(col), sheet: a, database: b });
            }
            break;
          }
        }
      }

      const onlyInDb = [...dbById.keys()].filter((id) => !sheetById.has(id));

      const diff: RestoreDiff = {
        entity: entity.name,
        rowsInSheet: sheetById.size,
        rowsInDatabase: dbById.size,
        missingInDatabase: missing.length,
        differing: differingCount,
        onlyInDatabase: onlyInDb.length,
        samples: {
          missingInDatabase: missing.slice(0, SAMPLE_LIMIT),
          differing,
          onlyInDatabase: onlyInDb.slice(0, SAMPLE_LIMIT),
        },
      };

      await this.prisma.db.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'SUCCESS',
          rowsProcessed: sheetById.size,
          rowsExpected: dbById.size,
          diffSummary: diff as unknown as object,
          completedAt: this.clock.now(),
          apiRequests: this.sheets.requestCount(),
        },
      });

      this.logger.info(
        {
          entity: entity.name,
          rowsInSheet: diff.rowsInSheet,
          rowsInDatabase: diff.rowsInDatabase,
          missingInDatabase: diff.missingInDatabase,
          differing: diff.differing,
        },
        'Restore dry run complete',
      );

      return diff;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.db.syncJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', error: message.slice(0, 1000), completedAt: this.clock.now() },
      });
      throw error;
    }
  }

  /**
   * Applying a restore is deliberately NOT implemented, and this is a decision
   * rather than an omission.
   *
   * Three things have to be true before writing a spreadsheet back into this
   * database is a responsible operation, and none of them is true yet:
   *
   *  1. **The statutory tables refuse it anyway.** `invoice`, `tax_note` and
   *     `payment` carry database triggers that reject edits once issued or
   *     verified (ADR-0016). A restore touching Payments would fail at the
   *     trigger, half way through, having already written whatever preceded it.
   *  2. **The backup is lossy by design.** `bank_account_encrypted` is exported
   *     as `[redacted]` (`backup-entities.ts`). Writing that back would destroy
   *     the real value — the backup cannot reconstruct what it deliberately
   *     refused to carry.
   *  3. **`pg_dump` is the recovery mechanism, not this** (ADR-0024, `docs/07`
   *     §2). Sheets is a convenience copy for human inspection. Building a
   *     second, weaker recovery path invites someone to reach for it in an
   *     incident.
   *
   * The dry run above is the valuable half and it is complete: it answers "does
   * the backup match the database", which is the question worth asking of a
   * backup between incidents.
   */
  applyRestore(): never {
    throw new ConflictError(
      'Applying a Sheets restore is not implemented, deliberately. The Sheets backup is a ' +
        'convenience copy for inspection; pg_dump is the recovery mechanism (ADR-0024). The ' +
        'export also redacts encrypted bank details, so it cannot faithfully reconstruct a ' +
        'distributor, and statutory tables reject writes by database trigger (ADR-0016). ' +
        'Use the dry run to compare, and restore from the encrypted pg_dump.',
    );
  }
}
