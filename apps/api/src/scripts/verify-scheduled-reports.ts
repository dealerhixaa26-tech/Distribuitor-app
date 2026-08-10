/**
 * Phase 10 — proves the scheduled-report runner by EXECUTION.
 *
 * Three things matter here, and only one of them is "does it run":
 *
 *   1. A schedule saved BEFORE this runner existed must be seeded, not fired.
 *      Otherwise every historical schedule blasts out at once on first deploy.
 *   2. A due schedule runs and delivers.
 *   3. ⚠️ It runs SCOPED TO ITS OWNER. Since ADR-0021 a SYSTEM principal reads
 *      unscoped, so a report run as SYSTEM would compute a territory manager's
 *      sales summary across every territory and then EMAIL it to them. That is
 *      a data leak with a delivery mechanism attached, and it is the thing this
 *      script exists to disprove.
 *
 * Run: pnpm --filter @hixaa/api build && node apps/api/dist/scripts/verify-scheduled-reports.js
 */
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../worker.module';
import { ClockService } from '../common/utils/clock.service';
import { RequestContextStore } from '../common/context/request-context';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { ScheduledReportsProcessor } from '../jobs/scheduled-reports.processor';
import { AccessService } from '../modules/auth/services/access.service';
import { OutboxDispatcherService } from '../infrastructure/outbox/outbox-dispatcher.service';

const ADMIN = '019fc992-0429-7d20-81e0-527357c9680c';
const WEST_MANAGER = '019fca7e-a697-72b3-bec1-2df7ee53752b';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error'] });

  let failures = 0;
  const check = (label: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? '  ✓' : '  ✗'} ${label}\n      ${detail}`);
    if (!ok) failures++;
  };

  const prisma = app.get(PrismaService);
  const clock = app.get(ClockService);
  const processor = app.get(ScheduledReportsProcessor);
  const created: string[] = [];

  /** The sweep, invoked directly rather than waiting for the minute to turn. */
  const sweep = (): Promise<void> => processor.sweep();

  try {
    const params = { from: '2026-04-01', to: '2027-03-31' };

    console.log('\n── 1. Is a pre-existing schedule SEEDED, not fired? ────────');
    const legacy = await RequestContextStore.withoutScope(() =>
      prisma.db.reportDefinition.create({
        data: {
          type: 'SALES_SUMMARY',
          name: 'Probe — legacy schedule',
          parameters: params,
          format: 'CSV',
          cronExpression: '0 9 * * *',
          recipients: ['probe@hixaa.test'],
          isScheduleActive: true,
          nextRunAt: null, // saved before the runner existed
          createdById: ADMIN,
        },
        select: { id: true },
      }),
    );
    created.push(legacy.id);

    const runsBefore = await prisma.db.reportRun.count();
    await sweep();
    const seeded = await RequestContextStore.withoutScope(() =>
      prisma.db.reportDefinition.findUnique({
        where: { id: legacy.id },
        select: { nextRunAt: true },
      }),
    );
    const runsAfter = await prisma.db.reportRun.count();

    check(
      'nextRunAt seeded and the report NOT fired',
      seeded?.nextRunAt != null && runsAfter === runsBefore,
      `nextRunAt=${seeded?.nextRunAt?.toISOString() ?? 'null'} · ` +
        `runs ${runsBefore} → ${runsAfter} (a first deploy must not blast every ` +
        `historical schedule at once)`,
    );

    console.log('\n── 2. Does a DUE schedule actually run? ────────────────────');
    await RequestContextStore.withoutScope(() =>
      prisma.db.reportDefinition.update({
        where: { id: legacy.id },
        data: { nextRunAt: new Date(clock.nowMs() - 60_000) },
      }),
    );
    await sweep();
    const afterDue = await prisma.db.reportRun.count();
    const lastRun = await prisma.db.reportRun.findFirst({
      where: { definitionId: legacy.id },
      orderBy: { createdAt: 'desc' },
      select: { status: true, rowCount: true, isScheduled: true },
    });
    check(
      'a due schedule produced a ReportRun',
      afterDue > runsAfter && lastRun?.status === 'SUCCESS',
      `runs ${runsAfter} → ${afterDue} · status=${lastRun?.status} · rows=${lastRun?.rowCount}`,
    );

    const advanced = await RequestContextStore.withoutScope(() =>
      prisma.db.reportDefinition.findUnique({
        where: { id: legacy.id },
        select: { nextRunAt: true },
      }),
    );
    check(
      'and nextRunAt advanced into the future',
      (advanced?.nextRunAt?.getTime() ?? 0) > clock.nowMs(),
      `next fire ${advanced?.nextRunAt?.toISOString()} — so a failing report waits ` +
        `for its slot instead of retrying every minute all day`,
    );

    console.log('\n── 3. ⚠️  DOES asUser() ACTUALLY SCOPE THE READ? ───────────');
    /*
     * The mechanism the runner depends on, tested directly.
     *
     * It cannot be tested through a full report run, because NO SEEDED ACCOUNT
     * is both TERRITORY-scoped and holds `analytics:read:financial` — every
     * report in the catalogue is financial, and the only territory-scoped
     * account (west.manager) lacks that permission. So a scheduled report owned
     * by them is REFUSED, which proves the permission check but says nothing
     * about scoping. Recorded as a seed gap rather than papered over; see
     * `HANDOFF` §4.14, which makes exactly this point about needing an account
     * of the right shape to test a control.
     *
     * What is proven here is the thing that would leak: that a read inside
     * `asUser(west.manager)` is scoped, where the same read as SYSTEM is not.
     */
    const westAccess = await app.get(AccessService).resolve(WEST_MANAGER);

    const unscopedCount = await RequestContextStore.withoutScope(() =>
      prisma.db.distributor.count(),
    );
    const asSystemCount = await OutboxDispatcherService.asSystem('verify:scope', () =>
      prisma.db.distributor.count(),
    );
    const asOwnerCount = await RequestContextStore.asUser(
      {
        userId: WEST_MANAGER,
        access: westAccess,
        label: 'verify:scope',
        requestId: 'verify',
      },
      () => prisma.db.distributor.count(),
    );

    check(
      'a read as SYSTEM is unscoped — which is why a report must not use it',
      asSystemCount === unscopedCount,
      `SYSTEM sees ${asSystemCount} of ${unscopedCount} distributors (ADR-0021)`,
    );
    check(
      'the same read as the OWNER is SCOPED',
      asOwnerCount < unscopedCount,
      `west.manager sees ${asOwnerCount} of ${unscopedCount}. Equal counts would mean a ` +
        `scheduled report computes across every territory and emails it to one manager.`,
    );

    console.log('\n── 4. Permission is enforced too ───────────────────────────');
    // The same report, same parameters, owned by a GLOBAL admin and by a
    // TERRITORY-scoped manager. If the runner ran as SYSTEM both would see the
    // whole dataset and the row counts would match.
    const globalDef = await RequestContextStore.withoutScope(() =>
      prisma.db.reportDefinition.create({
        data: {
          type: 'DISTRIBUTOR_PERFORMANCE',
          name: 'Probe — owned by GLOBAL admin',
          parameters: params,
          format: 'CSV',
          cronExpression: '0 9 * * *',
          recipients: ['probe@hixaa.test'],
          isScheduleActive: true,
          nextRunAt: new Date(clock.nowMs() - 60_000),
          createdById: ADMIN,
        },
        select: { id: true },
      }),
    );
    const scopedDef = await RequestContextStore.withoutScope(() =>
      prisma.db.reportDefinition.create({
        data: {
          type: 'DISTRIBUTOR_PERFORMANCE',
          name: 'Probe — owned by WEST-scoped manager',
          parameters: params,
          format: 'CSV',
          cronExpression: '0 9 * * *',
          recipients: ['probe@hixaa.test'],
          isScheduleActive: true,
          nextRunAt: new Date(clock.nowMs() - 60_000),
          createdById: WEST_MANAGER,
        },
        select: { id: true },
      }),
    );
    created.push(globalDef.id, scopedDef.id);

    await sweep();

    const globalRun = await prisma.db.reportRun.findFirst({
      where: { definitionId: globalDef.id },
      orderBy: { createdAt: 'desc' },
      select: { rowCount: true, status: true },
    });
    const scopedRun = await prisma.db.reportRun.findFirst({
      where: { definitionId: scopedDef.id },
      orderBy: { createdAt: 'desc' },
      select: { rowCount: true, status: true },
    });

    check(
      'a report owned by a permitted user runs',
      globalRun?.status === 'SUCCESS' && (globalRun.rowCount ?? 0) > 0,
      `global owner: status=${globalRun?.status}, rows=${globalRun?.rowCount}`,
    );
    check(
      'a report owned by a user WITHOUT analytics:read:financial is REFUSED',
      scopedRun === null,
      scopedRun === null
        ? 'no ReportRun produced — refused with PermissionDeniedError, as it should be. ' +
          'The permission check applies under asUser(), not only on the HTTP path.'
        : `UNEXPECTEDLY RAN: status=${scopedRun.status}, rows=${scopedRun.rowCount}`,
    );

    console.log('\n── 5. ⚠️  FULL SCHEDULED RUN — scoped AND permitted ────────');
    /*
     * Phase 11 — closes the seed gap from docs/30 §9.
     *
     * west.analyst@hixaa.test is REGIONAL_ANALYST: territory-scoped to West
     * Zone AND holds analytics:read:financial. This is the shape no account
     * had before, which meant report scoping could only be proven at the
     * context level (check 3 above), never through a full scheduled run.
     *
     * The test: a financial report owned by west.analyst runs (not refused)
     * and produces FEWER rows than the same report owned by a global admin.
     * If the runner ignores the owner's scope, both will return the same
     * count — which is the data leak ADR-0021 exists to prevent.
     */
    const analyst = await RequestContextStore.withoutScope(() =>
      prisma.db.user.findUnique({
        where: { email: 'west.analyst@hixaa.test' },
        select: { id: true },
      }),
    );

    if (!analyst) {
      check(
        'west.analyst@hixaa.test exists (run pnpm db:seed first)',
        false,
        'The account that closes the seed gap is missing. Seed it.',
      );
    } else {
      const analystDef = await RequestContextStore.withoutScope(() =>
        prisma.db.reportDefinition.create({
          data: {
            type: 'DISTRIBUTOR_PERFORMANCE',
            name: 'Probe — owned by WEST-scoped analyst (has financial permission)',
            parameters: params,
            format: 'CSV',
            cronExpression: '0 9 * * *',
            recipients: ['probe@hixaa.test'],
            isScheduleActive: true,
            nextRunAt: new Date(clock.nowMs() - 60_000),
            createdById: analyst.id,
          },
          select: { id: true },
        }),
      );
      created.push(analystDef.id);

      await sweep();

      const analystRun = await prisma.db.reportRun.findFirst({
        where: { definitionId: analystDef.id },
        orderBy: { createdAt: 'desc' },
        select: { rowCount: true, status: true },
      });

      check(
        'a financial report owned by a PERMITTED + SCOPED user RUNS (not refused)',
        analystRun?.status === 'SUCCESS' && (analystRun.rowCount ?? 0) > 0,
        `status=${analystRun?.status}, rows=${analystRun?.rowCount}`,
      );

      check(
        'and it sees FEWER rows than the global admin — the scope is real',
        analystRun != null &&
          globalRun != null &&
          (analystRun.rowCount ?? 0) < (globalRun.rowCount ?? 0),
        `analyst(west) sees ${analystRun?.rowCount} vs admin(global) sees ${globalRun?.rowCount}. ` +
          `Equal counts would mean asUser() is not scoping the report's query — ` +
          `the data leak ADR-0021 exists to prevent.`,
      );
    }
  } catch (error) {
    console.error('\n  ✗ threw:', error instanceof Error ? error.message : error);
    failures++;
  } finally {
    /*
     * Leave no probes behind.
     *
     * ⚠️ `deleteMany` THROWS on a soft-deletable model — HANDOFF §4.2, and the
     * extension names the method to use. The first version of this cleanup
     * called it and swallowed the error with `.catch(() => undefined)`, which
     * left SIXTEEN probe definitions in the database across runs and reported
     * nothing. Test cleanup that hides its own failure is how a "clean" harness
     * quietly pollutes a database.
     *
     * Raw SQL rather than softDelete: these are probes, and a soft-deleted
     * probe is still a row the next run has to reason about.
     */
    if (created.length > 0) {
      try {
        await prisma.db.$executeRawUnsafe(
          `DELETE FROM report_run WHERE definition_id = ANY($1::uuid[])`,
          created,
        );
        await prisma.db.$executeRawUnsafe(
          `DELETE FROM report_definition WHERE id = ANY($1::uuid[])`,
          created,
        );
      } catch (error) {
        // Reported, never swallowed.
        console.error('  ⚠️  cleanup FAILED — probes remain:', error);
        failures++;
      }
    }
    await app.close();
  }

  console.log(
    failures === 0
      ? '\nScheduled reports run, and run as their owner.\n'
      : `\n${failures} scheduled-report check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
