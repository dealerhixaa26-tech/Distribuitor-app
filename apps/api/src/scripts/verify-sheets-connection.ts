/**
 * Read-only first contact with Google Sheets. Phase 10.1 / question E7.
 *
 * Run this BEFORE a real backup when credentials are first configured. It
 * authenticates and reads spreadsheet metadata; it writes nothing, so a
 * misconfiguration cannot damage a live sheet.
 *
 * It exists because the two failure modes are not self-describing:
 *   • bad credentials → the token exchange fails;
 *   • spreadsheet never shared with the service account → the token succeeds
 *     and the read returns 403, NOT 404, which reads like bad credentials.
 *
 * Run: pnpm --filter @hixaa/api build && node apps/api/dist/scripts/verify-sheets-connection.js
 */
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../worker.module';
import { AppConfigService } from '../config/app-config.service';
import { SheetsPort } from '../infrastructure/sheets/sheets.port';
import { BackupService } from '../modules/backup/backup.service';
import { BACKUP_ENTITIES } from '../modules/backup/backup-entities';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error'] });
  let failures = 0;

  try {
    const config = app.get(AppConfigService);
    const sheets = app.get(SheetsPort);
    const backup = app.get(BackupService);

    console.log(`\n  adapter:        ${sheets.provider}`);
    console.log(`  service account: ${config.sheets.serviceAccountEmail || '(none)'}`);

    if (sheets.provider !== 'GOOGLE') {
      console.log(
        '\n  ⚠️  SHEETS_ENABLED is not true, so the LOCAL adapter is selected.\n' +
          '      Nothing to verify against Google. See docs/28 §5.\n',
      );
      await app.close();
      process.exit(0);
    }

    // Resolve the same books the export writes to, rather than re-deriving them.
    const shards = new Map<string, string[]>();
    for (const entity of BACKUP_ENTITIES) {
      const id = backup.spreadsheetFor(entity);
      shards.set(id, [...(shards.get(id) ?? []), entity.name]);
    }

    console.log(`\n── Reachability (read-only) ────────────────────────────────`);
    for (const [spreadsheetId, entities] of shards) {
      const result = await sheets.probe(spreadsheetId);
      const shown = `${spreadsheetId.slice(0, 8)}…${spreadsheetId.slice(-4)}`;
      console.log(`${result.ok ? '  ✓' : '  ✗'} ${shown}  (${entities.join(', ')})`);
      console.log(`      ${result.detail}`);
      if (!result.ok) failures++;
    }

    console.log(`\n  requests used: ${sheets.requestCount()}`);
  } catch (error) {
    console.error('\n  ✗ threw:', error instanceof Error ? error.message : error);
    failures++;
  } finally {
    await app.close();
  }

  console.log(
    failures === 0
      ? '\nBoth spreadsheets are reachable. Safe to run a real backup.\n'
      : `\n${failures} spreadsheet(s) unreachable — fix before backing up. See docs/28 §7.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
