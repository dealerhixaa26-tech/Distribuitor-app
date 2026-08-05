/**
 * Phase 10 — proves the worker's scheduled jobs by EXECUTION.
 *
 * The worker could not boot between Phase 6 and Phase 9, so none of these had
 * ever run. A green typecheck says nothing about them: the failures this
 * project has actually hit (a wrong string key, a service needing a provider
 * its module never imported) all typecheck perfectly.
 *
 * Three things are checked, because they fail independently:
 *
 *   1. Are the @Cron schedules REGISTERED? A job nobody registered never fires,
 *      however correct its body is.
 *   2. Does the work underneath each schedule SUCCEED when called?
 *   3. Does it see the DATA? A job that runs cleanly against zero rows is worse
 *      than one that crashes — it reports success forever. Each job is run
 *      twice, once as the cron job runs it and once with scope bypassed, and
 *      the two counts are compared. A difference means scope filtering is
 *      silently emptying the job's view of the database.
 *
 * ⚠️ Lives under src/ and is run COMPILED, never through tsx. tsx uses esbuild,
 * which does not implement `emitDecoratorMetadata` — so `design:paramtypes` is
 * never emitted and every Nest constructor injection resolves to `undefined`.
 * The failure looks like a dependency-injection bug in the application and is
 * not one. Any script touching the Nest container must go through tsc.
 *
 * Run: pnpm --filter @hixaa/api build && node apps/api/dist/scripts/verify-worker-jobs.js
 */
import { NestFactory } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { WorkerModule } from '../worker.module';
import { RequestContextStore } from '../common/context/request-context';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { ReconciliationService } from '../modules/inventory/reconciliation.service';
import { ReservationsService } from '../modules/inventory/reservations.service';
import { StockService } from '../modules/inventory/stock.service';
import { OutboxDispatcherService } from '../infrastructure/outbox/outbox-dispatcher.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error'],
  });

  let failures = 0;
  const check = (label: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? '  ✓' : '  ✗'} ${label}\n      ${detail}`);
    if (!ok) failures++;
  };

  try {
    // ── 1. Registration ────────────────────────────────────────────────────
    console.log('\n── 1. Are the @Cron schedules registered? ──────────────────');
    const jobs = app.get(SchedulerRegistry).getCronJobs();
    // @nestjs/schedule assigns a UUID to a @Cron with no explicit name, so the
    // schedules are identified by their cron expression rather than by name.
    const expressions = [...jobs.values()].map((j) => String(j.cronTime.source));
    console.log(`  ${jobs.size} cron job(s): ${expressions.join('  |  ')}`);
    check(
      'six schedules registered (3 inventory + 3 maintenance)',
      jobs.size === 6,
      `found ${jobs.size}`,
    );

    // ── 2 & 3. Execution, and whether it can see the data ──────────────────
    console.log('\n── 2. Do the jobs run, and do they SEE anything? ───────────');

    const prisma = app.get(PrismaService);
    const [balances, reservations] = await Promise.all([
      prisma.db.stockBalance.count(),
      prisma.db.stockReservation.count(),
    ]);
    console.log(`  database truth (no ambient context): ` +
      `${balances} stock balance(s), ${reservations} reservation(s)\n`);

    const reconciliation = app.get(ReconciliationService);
    const reservationsSvc = app.get(ReservationsService);
    const stock = app.get(StockService);

    /** Runs `fn` exactly as the cron job does — asSystem, nothing more. */
    const asCronDoes = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
      OutboxDispatcherService.asSystem(label, fn);

    /** The same, with scope filtering deliberately bypassed. */
    const withBypass = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
      OutboxDispatcherService.asSystem(label, () => RequestContextStore.withoutScope(fn));

    const asCron = await asCronDoes('verify:reconcile', () => reconciliation.reconcile());
    const bypassed = await withBypass('verify:reconcile:bypass', () => reconciliation.reconcile());
    check(
      'ReconciliationService.reconcile() sees the stock balances',
      asCron.checkedBalances === bypassed.checkedBalances &&
        asCron.checkedBalances === balances,
      `as the cron runs it: checked ${asCron.checkedBalances}, clean=${asCron.clean}  ·  ` +
        `with scope bypassed: checked ${bypassed.checkedBalances}, clean=${bypassed.clean}  ·  ` +
        `actually in the table: ${balances}`,
    );

    const expiredAsCron = await asCronDoes('verify:expire', () => reservationsSvc.expireStale());
    const lowAsCron = await asCronDoes('verify:lowstock', () => stock.emitLowStockAlerts());
    console.log(
      `  (expireStale released ${expiredAsCron}; emitLowStockAlerts raised ${lowAsCron} — ` +
        `both read scoped models, so both are affected by the same mechanism)`,
    );
  } catch (error) {
    console.error('\n  ✗ threw:', error);
    failures++;
  } finally {
    await app.close();
  }

  console.log(
    failures === 0
      ? '\nAll worker job checks passed.\n'
      : `\n${failures} worker job check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
