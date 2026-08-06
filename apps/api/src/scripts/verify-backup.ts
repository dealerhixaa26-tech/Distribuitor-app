/**
 * Phase 10.1 — proves the Sheets backup by EXECUTION, against the real
 * database and the real local adapter.
 *
 * This is the point of ADR-0023. There is no Google service account (E7), but
 * everything that will actually be wrong — chunking, checkpoint resumption,
 * masking, the zero-row guard, the restore diff — is provider-agnostic and can
 * be run for real today. A mock would prove only that methods were called.
 *
 * Run: pnpm --filter @hixaa/api build && node apps/api/dist/scripts/verify-backup.js
 */
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../worker.module';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { SheetsPort } from '../infrastructure/sheets/sheets.port';
import { OutboxDispatcherService } from '../infrastructure/outbox/outbox-dispatcher.service';
import { BackupService } from '../modules/backup/backup.service';
import { RestoreService } from '../modules/backup/restore.service';
import { BACKUP_ENTITIES } from '../modules/backup/backup-entities';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error'] });

  let failures = 0;
  const check = (label: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? '  ✓' : '  ✗'} ${label}\n      ${detail}`);
    if (!ok) failures++;
  };

  try {
    const prisma = app.get(PrismaService);
    const sheets = app.get(SheetsPort);
    const backup = app.get(BackupService);
    const restore = app.get(RestoreService);

    console.log(`\n  adapter in use: ${sheets.provider}\n`);

    const usersEntity = BACKUP_ENTITIES.find((e) => e.name === 'Users');
    const distEntity = BACKUP_ENTITIES.find((e) => e.name === 'Distributors');
    if (!usersEntity || !distEntity) throw new Error('BACKUP_ENTITIES is missing a core entity');

    // Reuse the service's own resolution. Computing the target independently
    // here could pass while the real export wrote somewhere else.
    const usersAt = { spreadsheetId: backup.spreadsheetFor(usersEntity), title: 'Users' };
    const distAt = { spreadsheetId: backup.spreadsheetFor(distEntity), title: 'Distributors' };

    // ── 1. A full run, as the cron runs it ────────────────────────────────
    console.log('── 1. Does a full backup export real rows? ─────────────────');
    const result = await OutboxDispatcherService.asSystem('verify:backup', () =>
      backup.runAll({ isScheduled: false }),
    );

    check(
      'every entity succeeded',
      result.status === 'SUCCESS',
      `status=${result.status} · ` +
        result.entities.map((e) => `${e.entity} ${e.rowsProcessed}/${e.rowsExpected}`).join(' · '),
    );

    // The whole point of rowsExpected: a run that exports nothing from a
    // non-empty table must not be able to report success.
    const silentlyEmpty = result.entities.filter(
      (e) => e.rowsExpected > 0 && e.rowsProcessed === 0 && e.status === 'SUCCESS',
    );
    check(
      'no entity reported success over zero rows',
      silentlyEmpty.length === 0,
      silentlyEmpty.length === 0
        ? 'every non-empty table exported at least one row'
        : `SILENT EMPTY BACKUP: ${silentlyEmpty.map((e) => e.entity).join(', ')}`,
    );

    // ── 2. Masking ───────────────────────────────────────────────────────
    console.log('\n── 2. Did anything sensitive reach the sheet? ──────────────');
    const distributors = distEntity;

    const distRows = await sheets.readRows(distAt);
    const userRows = await sheets.readRows(usersAt);

    // Compare against the truth in the database rather than trusting the mapper.
    const realHashes = (
      await prisma.db.user.findMany({ select: { passwordHash: true } })
    )
      .map((u) => u.passwordHash)
      .filter((h): h is string => Boolean(h));
    const flatUsers = JSON.stringify(userRows);
    const leakedHash = realHashes.find((h) => flatUsers.includes(h));
    check(
      'no password hash in the Users sheet',
      !leakedHash,
      leakedHash ? `LEAKED a hash` : `${realHashes.length} hashes checked, none present`,
    );

    const realBank = (
      await prisma.db.distributor.findMany({ select: { bankAccountEncrypted: true } })
    )
      .map((d) => d.bankAccountEncrypted)
      .filter((b): b is string => Boolean(b));
    const flatDist = JSON.stringify(distRows);
    const leakedBank = realBank.find((b) => flatDist.includes(b));
    const bankCol = distributors?.header.indexOf('bankAccount') ?? -1;
    const redactedCount = distRows
      .slice(1)
      .filter((r) => r[bankCol] === '[redacted]').length;
    check(
      'no encrypted bank number in the Distributors sheet',
      !leakedBank,
      leakedBank
        ? 'LEAKED an encrypted bank value'
        : `${realBank.length} on file, ${redactedCount} row(s) marked [redacted], 0 leaked`,
    );

    // Header/row width must agree or the restore diff compares the wrong columns.
    const widthMismatch = distRows.slice(1).filter((r) => r.length !== distributors?.header.length);
    check(
      'every row matches its header width',
      widthMismatch.length === 0,
      `header=${distributors?.header.length} cols, ${widthMismatch.length} mismatched row(s)`,
    );

    // ── 3. Chunking and re-runs ──────────────────────────────────────────
    console.log('\n── 3. Is a re-run idempotent, not doubled? ─────────────────');
    const firstUserRows = userRows.length;
    await OutboxDispatcherService.asSystem('verify:backup:2', () => backup.runAll({}));
    const afterRerun = await sheets.readRows(usersAt);
    check(
      're-running replaces rather than appends',
      afterRerun.length === firstUserRows,
      `${firstUserRows} rows before, ${afterRerun.length} after — a full replace via staging+swap`,
    );

    // ── 4. Restore dry run ───────────────────────────────────────────────
    console.log('\n── 4. Does the restore dry run diff correctly? ─────────────');
    const clean = await OutboxDispatcherService.asSystem('verify:restore', () =>
      restore.dryRun('Users'),
    );
    check(
      'a fresh backup diffs as identical',
      clean.missingInDatabase === 0 && clean.differing === 0 && clean.onlyInDatabase === 0,
      `sheet=${clean.rowsInSheet} db=${clean.rowsInDatabase} missing=${clean.missingInDatabase} ` +
        `differing=${clean.differing} onlyInDb=${clean.onlyInDatabase}`,
    );

    // Corrupt one cell and confirm the diff NOTICES. A diff that always says
    // "identical" is the backup equivalent of a reconciliation over zero rows.
    const corrupted = afterRerun.map((r, i) => (i === 1 ? [...r.slice(0, 2), 'MUTATED', ...r.slice(3)] : r));
    await sheets.deleteSheet(usersAt);
    await sheets.ensureSheet(usersAt);
    await sheets.appendRows(usersAt, corrupted);

    const dirty = await OutboxDispatcherService.asSystem('verify:restore:dirty', () =>
      restore.dryRun('Users'),
    );
    check(
      'a mutated cell is detected',
      dirty.differing === 1,
      `differing=${dirty.differing}` +
        (dirty.samples.differing[0]
          ? ` · ${dirty.samples.differing[0].column}: sheet="${dirty.samples.differing[0].sheet}" db="${dirty.samples.differing[0].database}"`
          : ''),
    );

    // ── 5. The zero-row guard ────────────────────────────────────────────
    console.log('\n── 5. Does an empty export FAIL rather than publish? ───────');
    const fakeEntity = {
      ...usersEntity,
      name: 'ZeroRowProbe',
      // Claims rows exist, then yields none — exactly the shape of the
      // scope-filtered read that made every background job silently empty.
      count: async () => 99,
      page: async () => ({ rows: [] as string[][], nextCursor: undefined }),
    };
    const probe = await OutboxDispatcherService.asSystem('verify:zero', () =>
      backup.runEntity(fakeEntity as never, {}),
    );
    check(
      'exporting 0 of 99 rows is a FAILURE',
      probe.status === 'FAILED',
      probe.status === 'FAILED'
        ? `refused: ${probe.error?.slice(0, 90)}…`
        : 'PUBLISHED AN EMPTY BACKUP — the guard did not fire',
    );

    // ── 6. SyncJob rows ──────────────────────────────────────────────────
    console.log('\n── 6. Is the run recorded? ────────────────────────────────');
    const jobs = await backup.listJobs(100);
    const exports = jobs.filter((j) => j.direction === 'EXPORT');
    check(
      'every entity run left a SyncJob row',
      exports.length >= BACKUP_ENTITIES.length,
      `${jobs.length} job rows (${exports.length} export, ${jobs.length - exports.length} restore)`,
    );

    // Restore the sheet to a true copy so the harness leaves no corruption.
    await OutboxDispatcherService.asSystem('verify:cleanup', () => backup.runAll({}));
  } catch (error) {
    console.error('\n  ✗ threw:', error);
    failures++;
  } finally {
    await app.close();
  }

  console.log(
    failures === 0 ? '\nAll backup checks passed.\n' : `\n${failures} backup check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
