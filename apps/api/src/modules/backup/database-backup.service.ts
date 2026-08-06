import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';

const run = promisify(execFile);

/** 30 minutes. A dump of a genuinely large database should not be killed early. */
const TIMEOUT_MS = 30 * 60_000;

export interface BackupOutcome {
  status: 'success' | 'failure';
  file?: string;
  plaintextBytes?: number;
  encryptedBytes?: number;
  durationSeconds: number;
  retainedFiles?: number;
  prunedFiles?: number;
  error?: string;
}

export interface RehearsalOutcome {
  status: 'success' | 'failure';
  file?: string;
  sourceTables: number;
  restoredTables: number;
  sourceRows: number;
  restoredRows: number;
  mismatches: string[];
  durationSeconds: number;
  error?: string;
}

/**
 * The `pg_dump` backup, and the rehearsal that proves it restorable.
 *
 * ── Why this SHELLS OUT instead of reimplementing the dump ──────────────────
 *
 * `scripts/backup.sh` and `scripts/restore.sh` are the operator's tools. They
 * have to work by hand, at 3 a.m., on a box where Node may be the thing that is
 * broken. Re-expressing them in TypeScript would produce two implementations
 * that drift, and the one an operator reaches for in an incident would be the
 * one nobody had exercised. So the cron runs exactly what a human would run.
 *
 * The scripts print JSON on stdout for that reason.
 */
@Injectable()
export class DatabaseBackupService {
  private readonly repoRoot: string;

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DatabaseBackupService.name);
    // dist/modules/backup → repo root. The scripts live outside the build.
    this.repoRoot = join(__dirname, '..', '..', '..', '..', '..');
  }

  private script(name: string): string {
    return join(this.repoRoot, 'scripts', name);
  }

  /** One nightly backup. Never throws — a cron must not die on a bad night. */
  async run(): Promise<BackupOutcome> {
    const started = Date.now();
    try {
      const { stdout } = await run(this.script('backup.sh'), [], {
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          BACKUP_DIR: this.config.backup.dir,
          BACKUP_GPG_RECIPIENT: this.config.backup.gpgRecipient,
          BACKUP_KEEP_DAILY: String(this.config.backup.keepDaily),
          BACKUP_KEEP_WEEKLY: String(this.config.backup.keepWeekly),
          BACKUP_KEEP_MONTHLY: String(this.config.backup.keepMonthly),
        },
      });

      const parsed = JSON.parse(stdout) as Omit<BackupOutcome, 'status'> & { status: 'success' };
      this.logger.info(
        {
          file: parsed.file,
          encryptedBytes: parsed.encryptedBytes,
          retained: parsed.retainedFiles,
        },
        'Database backup complete',
      );
      return { ...parsed, status: 'success' };
    } catch (error) {
      const message = this.describe(error);
      this.logger.error({ err: error }, 'Database backup FAILED');
      return {
        status: 'failure',
        durationSeconds: Math.round((Date.now() - started) / 1000),
        error: message,
      };
    }
  }

  /**
   * Restore the newest backup into a scratch database and compare row counts.
   *
   * ADR-0024's central claim: a `pg_dump` that exits 0 proves the command ran,
   * not that the output can be restored. This is the check that makes the
   * difference observable on a schedule rather than during an incident.
   *
   * The scratch database is DROPPED and recreated each time, so it must never
   * name a real one — `restore.sh` additionally refuses `hixaa_dms` outright.
   */
  async rehearse(): Promise<RehearsalOutcome> {
    const started = Date.now();
    const scratch = this.config.backup.rehearsalDb;
    const empty: RehearsalOutcome = {
      status: 'failure',
      sourceTables: 0,
      restoredTables: 0,
      sourceRows: 0,
      restoredRows: 0,
      mismatches: [],
      durationSeconds: 0,
    };

    try {
      const { stdout: latest } = await run(
        '/bin/sh',
        ['-c', `ls -1t ${JSON.stringify(this.config.backup.dir)}/hixaa-*.dump.gpg 2>/dev/null | head -1`],
        { timeout: 30_000 },
      );
      const file = latest.trim();
      if (!file) {
        return { ...empty, error: 'No backup file found to rehearse', durationSeconds: 0 };
      }

      const adminUrl = this.adminUrl();
      await run('/bin/sh', ['-c', `dropdb --if-exists ${scratch} && createdb ${scratch}`], {
        timeout: 60_000,
      });

      await run(this.script('restore.sh'), [file, `${adminUrl}/${scratch}`, '--force'], {
        timeout: TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });

      const source = await this.counts(this.prisma);
      const restored = await this.countsVia(`${adminUrl}/${scratch}`);

      // Compare table by table, not just totals: two tables that are wrong in
      // opposite directions would net to the right total.
      const mismatches: string[] = [];
      for (const [table, n] of source) {
        const got = restored.get(table);
        if (got === undefined) mismatches.push(`${table}: missing from restore`);
        else if (got !== n) mismatches.push(`${table}: ${n} → ${got}`);
      }
      for (const table of restored.keys()) {
        if (!source.has(table)) mismatches.push(`${table}: present only in restore`);
      }

      const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
      const outcome: RehearsalOutcome = {
        status: mismatches.length === 0 ? 'success' : 'failure',
        file,
        sourceTables: source.size,
        restoredTables: restored.size,
        sourceRows: sum(source),
        restoredRows: sum(restored),
        mismatches: mismatches.slice(0, 20),
        durationSeconds: Math.round((Date.now() - started) / 1000),
      };

      // Dropped on success; KEPT on failure, so there is something to inspect.
      if (outcome.status === 'success') {
        await run('/bin/sh', ['-c', `dropdb --if-exists ${scratch}`], { timeout: 60_000 });
      } else {
        this.logger.error({ mismatches: outcome.mismatches, scratch }, 'Restore rehearsal FAILED');
      }

      return outcome;
    } catch (error) {
      return {
        ...empty,
        error: this.describe(error),
        durationSeconds: Math.round((Date.now() - started) / 1000),
      };
    }
  }

  /** Exact row counts for every public table, via the app's own connection. */
  private async counts(prisma: PrismaService): Promise<Map<string, number>> {
    const rows = await prisma.db.$queryRawUnsafe<Array<{ table_name: string; n: bigint }>>(
      buildCountQuery(await tableNames(prisma)),
    );
    return new Map(rows.map((r) => [r.table_name, Number(r.n)]));
  }

  /** The same, over psql, for a database Prisma has no client for. */
  private async countsVia(url: string): Promise<Map<string, number>> {
    const { stdout } = await run(
      '/bin/sh',
      [
        '-c',
        `psql ${JSON.stringify(url)} -t -A -c "SELECT string_agg(format('SELECT %L AS t, count(*) AS n FROM %I', tablename, tablename), ' UNION ALL ') FROM pg_tables WHERE schemaname='public';" | psql ${JSON.stringify(url)} -t -A -F'|' -f -`,
      ],
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
    );

    const map = new Map<string, number>();
    for (const line of stdout.split('\n')) {
      const [table, n] = line.split('|');
      if (table && n !== undefined) map.set(table.trim(), Number(n));
    }
    return map;
  }

  /** DATABASE_URL with the database name and Prisma's params removed. */
  private adminUrl(): string {
    const url = this.config.database.url.split('?')[0] ?? '';
    return url.slice(0, url.lastIndexOf('/'));
  }

  private describe(error: unknown): string {
    if (error && typeof error === 'object' && 'stderr' in error) {
      const stderr = String((error as { stderr: unknown }).stderr).trim();
      if (stderr) return stderr.slice(0, 1000);
    }
    return error instanceof Error ? error.message.slice(0, 1000) : String(error);
  }
}

async function tableNames(prisma: PrismaService): Promise<string[]> {
  const rows = await prisma.db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
  `;
  return rows.map((r) => r.tablename);
}

/**
 * Built from `pg_tables`, never from user input — the identifiers come from the
 * catalogue itself, so there is nothing here an attacker could reach. Written
 * out rather than parameterised because a table name cannot be a bind
 * parameter.
 */
function buildCountQuery(tables: string[]): string {
  if (tables.length === 0) return `SELECT ''::text AS table_name, 0::bigint AS n WHERE false`;
  return tables
    .map((t) => `SELECT '${t}'::text AS table_name, count(*)::bigint AS n FROM "${t}"`)
    .join(' UNION ALL ');
}
