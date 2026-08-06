/**
 * Phase 10.4 — proves the monitoring by EXECUTION.
 *
 * The control being tested here is the one whose absence defined this whole
 * phase: the worker did not boot between Phase 6 and Phase 9 and NOTHING
 * NOTICED, because a dead worker emits an absence rather than an error.
 *
 * So the test that matters is not "does the heartbeat write a row" — it is
 * "would this have caught a dead worker?". That is checked directly, by ageing
 * the heartbeat past its threshold and asserting the system says so.
 *
 * Run: pnpm --filter @hixaa/api build && node apps/api/dist/scripts/verify-monitoring.js
 */
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../worker.module';
import { ClockService } from '../common/utils/clock.service';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { OutboxDispatcherService } from '../infrastructure/outbox/outbox-dispatcher.service';
import {
  JobHeartbeatService,
  STALE_AFTER,
  WORKER_SIGNAL,
  WORKER_STALE_SECONDS,
} from '../modules/health/job-heartbeat.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error'] });

  let failures = 0;
  const check = (label: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? '  ✓' : '  ✗'} ${label}\n      ${detail}`);
    if (!ok) failures++;
  };

  try {
    const prisma = app.get(PrismaService);
    const heartbeat = app.get(JobHeartbeatService);
    // The app's own clock, not `new Date()` — the lint rule that forbids it
    // applies here too, and the container is already booted.
    const clock = app.get(ClockService);

    console.log('\n── 1. Does the worker report in at all? ────────────────────');
    // onModuleInit beats at boot, so a row should already exist.
    const initial = await heartbeat.worker();
    check(
      'the worker wrote a heartbeat on boot',
      initial !== null && !initial.isStale,
      initial
        ? `status=${initial.status}, ${initial.secondsSinceSeen}s ago, ` +
          `stale threshold ${WORKER_STALE_SECONDS}s`
        : 'NO HEARTBEAT ROW — the worker is invisible, exactly as before',
    );

    console.log('\n── 2. WOULD IT HAVE CAUGHT A DEAD WORKER? ──────────────────');
    // Age the heartbeat past its threshold — the database equivalent of the
    // worker having died several minutes ago.
    await prisma.db.jobHeartbeat.update({
      where: { name: WORKER_SIGNAL },
      data: { lastSeenAt: new Date(clock.nowMs() - (WORKER_STALE_SECONDS + 60) * 1000) },
    });

    const dead = await heartbeat.worker();
    check(
      'a worker silent past its threshold reads as STALE',
      dead?.isStale === true,
      dead
        ? `${dead.secondsSinceSeen}s since last seen → isStale=${dead.isStale}`
        : 'no heartbeat row',
    );

    const unhealthy = await heartbeat.unhealthy();
    check(
      'and it appears in the unhealthy set the alerter reads',
      unhealthy.some((h) => h.name === WORKER_SIGNAL),
      `unhealthy signals: ${unhealthy.map((h) => h.name).join(', ') || '(none)'}`,
    );

    // Put it back, so the harness leaves the worker looking alive.
    await OutboxDispatcherService.asSystem('verify:monitoring', () =>
      heartbeat.beat(clock.now(), 'verify'),
    );
    const revived = await heartbeat.worker();
    check(
      'and recovers once it beats again',
      revived?.isStale === false,
      `isStale=${revived?.isStale}, ${revived?.secondsSinceSeen}s ago`,
    );

    console.log('\n── 3. Do JOBS record their own runs? ───────────────────────');
    const before = await prisma.db.jobHeartbeat.count();

    await OutboxDispatcherService.asSystem('verify:track', async () => {
      await heartbeat.track('verify-probe', STALE_AFTER.DAILY, async () => 'ok');
    });
    const good = (await heartbeat.list()).find((h) => h.name === 'verify-probe');
    check(
      'a successful run records SUCCESS with a duration',
      good?.status === 'SUCCESS' && good.lastSuccessAt !== null,
      `status=${good?.status}, lastSuccessAt set=${good?.lastSuccessAt !== null}, ` +
        `durationMs=${good?.lastDurationMs}`,
    );

    // A failing job must be recorded as failing AND rethrow — track() observes,
    // it does not swallow.
    let rethrew = false;
    try {
      await OutboxDispatcherService.asSystem('verify:track:fail', async () => {
        await heartbeat.track('verify-probe', STALE_AFTER.DAILY, async () => {
          throw new Error('deliberate probe failure');
        });
      });
    } catch {
      rethrew = true;
    }
    const bad = (await heartbeat.list()).find((h) => h.name === 'verify-probe');
    check(
      'a failing run records FAILED and rethrows',
      bad?.status === 'FAILED' && rethrew,
      `status=${bad?.status}, rethrew=${rethrew}, lastError="${bad?.lastError}"`,
    );

    // The distinction that matters: still "seen", no longer "succeeding".
    check(
      'lastSuccessAt is preserved, so alive-but-broken is visible',
      bad?.lastSuccessAt !== null && bad?.status === 'FAILED',
      `A job failing every hour is alive and broken. lastSeenAt moves, ` +
        `lastSuccessAt does not — that is the difference this column exists for.`,
    );

    console.log(`\n  signals tracked: ${before} → ${await prisma.db.jobHeartbeat.count()}`);

    // Leave nothing behind.
    await prisma.db.jobHeartbeat.deleteMany({ where: { name: 'verify-probe' } });
  } catch (error) {
    console.error('\n  ✗ threw:', error instanceof Error ? error.message : error);
    failures++;
  } finally {
    await app.close();
  }

  console.log(
    failures === 0
      ? '\nA dead worker would now be noticed.\n'
      : `\n${failures} monitoring check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
