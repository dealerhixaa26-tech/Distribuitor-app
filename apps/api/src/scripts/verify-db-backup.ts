/**
 * Phase 10.3 — proves the database backup AND its restore by EXECUTION.
 *
 * ADR-0024's whole claim is that a `pg_dump` exiting 0 proves the command ran,
 * not that the output can be restored. So this does not check exit codes: it
 * takes a real backup, restores it into a scratch database, and compares every
 * table's row count between source and restore.
 *
 * Driven through `DatabaseBackupService` rather than the shell, so what is
 * proven is the path the CRON actually takes — the scripts are exercised
 * underneath, being what the service invokes.
 *
 * Run: pnpm --filter @hixaa/api build && node apps/api/dist/scripts/verify-db-backup.js
 */
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../worker.module';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseBackupService } from '../modules/backup/database-backup.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error'] });

  let failures = 0;
  const check = (label: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? '  ✓' : '  ✗'} ${label}\n      ${detail}`);
    if (!ok) failures++;
  };

  try {
    const config = app.get(AppConfigService);
    const backup = app.get(DatabaseBackupService);

    console.log(`\n  backup dir:  ${config.backup.dir}`);
    console.log(`  recipient:   ${config.backup.gpgRecipient || '(none — will refuse)'}`);
    console.log(`  scratch db:  ${config.backup.rehearsalDb}\n`);

    console.log('── 1. Does a backup actually get written? ──────────────────');
    const result = await backup.run();
    check(
      'pg_dump → gpg produced an encrypted file',
      result.status === 'success' && (result.encryptedBytes ?? 0) > 0,
      result.status === 'success'
        ? `${result.plaintextBytes} bytes → ${result.encryptedBytes} encrypted in ` +
          `${result.durationSeconds}s · ${result.retainedFiles} retained`
        : `FAILED: ${result.error}`,
    );

    console.log('\n── 2. Can it be RESTORED? (ADR-0024) ───────────────────────');
    const rehearsal = await backup.rehearse();
    check(
      'every table restored with an identical row count',
      rehearsal.status === 'success',
      rehearsal.status === 'success'
        ? `${rehearsal.restoredTables}/${rehearsal.sourceTables} tables · ` +
          `${rehearsal.restoredRows}/${rehearsal.sourceRows} rows · ${rehearsal.durationSeconds}s`
        : `FAILED: ${rehearsal.error ?? rehearsal.mismatches.join(' · ')}`,
    );

    // Totals agreeing is not the same as every table agreeing — two tables
    // wrong in opposite directions would net out. The service compares table by
    // table for that reason; this asserts it did.
    check(
      'no per-table mismatches',
      rehearsal.mismatches.length === 0,
      rehearsal.mismatches.length === 0
        ? 'source and restore agree table by table, not merely in total'
        : rehearsal.mismatches.join(' · '),
    );
  } catch (error) {
    console.error('\n  ✗ threw:', error instanceof Error ? error.message : error);
    failures++;
  } finally {
    await app.close();
  }

  console.log(
    failures === 0
      ? '\nThe backup is provably restorable.\n'
      : `\n${failures} check(s) FAILED — the backup is NOT proven.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
