import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/** The worker's own liveness signal. */
export const WORKER_SIGNAL = 'worker';

/**
 * How often the worker reports in. Well under the staleness threshold, so one
 * missed beat is not an alert — a scheduler hiccup should not page anyone.
 */
export const WORKER_BEAT_MS = 30_000;
export const WORKER_STALE_SECONDS = 120;

/**
 * How long each job may go quiet before it is stale.
 *
 * Generously above each schedule's own interval — roughly 1.5–2×, so a single
 * skipped or slow run is not an alert. The number that matters is the ORDER of
 * magnitude: a daily job silent for 26 hours has missed one, and that is worth
 * knowing; a daily job silent for 25 hours probably just ran late.
 */
export const STALE_AFTER = {
  /** Hourly. */
  HOURLY: 2 * 3600,
  /** Every 5 minutes. */
  FREQUENT: 15 * 60,
  /** Every 10 minutes. */
  TEN_MINUTES: 30 * 60,
  /** Daily. 26 hours — one missed run. */
  DAILY: 26 * 3600,
  /** Monthly. 35 days. */
  MONTHLY: 35 * 24 * 3600,
} as const;

export interface HeartbeatView {
  name: string;
  status: string;
  lastSeenAt: Date;
  lastSuccessAt: Date | null;
  secondsSinceSeen: number;
  isStale: boolean;
  /** Surfaced so an alert can state the threshold it actually breached. */
  staleAfterSeconds: number;
  lastDurationMs: number | null;
  lastError: string | null;
  runCount: number;
  failureCount: number;
}

/**
 * Liveness for work that serves no HTTP.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 *
 * `HANDOFF` §4.23: "A process that fails at boot fails SILENTLY if nothing
 * checks it." The worker did not boot for three phases and nothing noticed,
 * because a dead worker produces no error — it produces an absence, and nothing
 * was watching for an absence.
 *
 * Two signals, and both matter:
 *   • the WORKER beats every 30s, so the process itself is observable;
 *   • each JOB records its own run, so "did the nightly reconciliation actually
 *     run last night?" is a query rather than an archaeology exercise.
 *
 * A job that fails every hour is very much alive and completely broken, which
 * is why `lastSeenAt` and `lastSuccessAt` are separate columns.
 */
@Injectable()
export class JobHeartbeatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(JobHeartbeatService.name);
  }

  /** The worker saying it is alive. Cheap, and deliberately not a job run. */
  async beat(bootedAt: Date, version: string): Promise<void> {
    const now = this.clock.now();
    await this.prisma.db.jobHeartbeat.upsert({
      where: { name: WORKER_SIGNAL },
      create: {
        name: WORKER_SIGNAL,
        status: 'ALIVE',
        lastSeenAt: now,
        lastSuccessAt: now,
        staleAfterSeconds: WORKER_STALE_SECONDS,
        bootedAt,
        version,
      },
      update: { status: 'ALIVE', lastSeenAt: now, lastSuccessAt: now, bootedAt, version },
    });
  }

  /**
   * Runs `fn`, recording the outcome against `name`.
   *
   * Wrapping rather than asking each job to do its own bookkeeping: an
   * instrumentation step every job must remember is one some job will forget,
   * and the forgotten one is invisible by construction. That is precisely the
   * mistake `withoutScope` made — documented as a convention, then missed at all
   * three call sites that needed it (ADR-0021).
   *
   * Rethrows. This observes; it does not swallow.
   */
  async track<T>(name: string, staleAfterSeconds: number, fn: () => Promise<T>): Promise<T> {
    const startedMs = this.clock.nowMs();
    try {
      const result = await fn();
      await this.record(name, staleAfterSeconds, {
        status: 'SUCCESS',
        durationMs: this.clock.nowMs() - startedMs,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.record(name, staleAfterSeconds, {
        status: 'FAILED',
        durationMs: this.clock.nowMs() - startedMs,
        error: message.slice(0, 1000),
      });
      throw error;
    }
  }

  private async record(
    name: string,
    staleAfterSeconds: number,
    outcome: { status: 'SUCCESS' | 'FAILED'; durationMs: number; error?: string },
  ): Promise<void> {
    const now = this.clock.now();
    const failed = outcome.status === 'FAILED';

    try {
      await this.prisma.db.jobHeartbeat.upsert({
        where: { name },
        create: {
          name,
          status: outcome.status,
          lastSeenAt: now,
          lastSuccessAt: failed ? null : now,
          lastDurationMs: outcome.durationMs,
          lastError: outcome.error ?? null,
          staleAfterSeconds,
          runCount: 1,
          failureCount: failed ? 1 : 0,
        },
        update: {
          status: outcome.status,
          lastSeenAt: now,
          ...(failed ? {} : { lastSuccessAt: now }),
          lastDurationMs: outcome.durationMs,
          lastError: outcome.error ?? null,
          staleAfterSeconds,
          runCount: { increment: 1 },
          ...(failed ? { failureCount: { increment: 1 } } : {}),
        },
      });
    } catch (error) {
      // Recording a heartbeat must never be the reason a job fails. The job's
      // own outcome is the thing that matters; losing one observation is not.
      this.logger.error({ err: error, job: name }, 'Could not record job heartbeat');
    }
  }

  /** Every signal, with staleness computed against each one's own threshold. */
  async list(): Promise<HeartbeatView[]> {
    const rows = await this.prisma.db.jobHeartbeat.findMany({ orderBy: { name: 'asc' } });
    const nowMs = this.clock.nowMs();

    return rows.map((row) => {
      const secondsSinceSeen = Math.floor((nowMs - row.lastSeenAt.getTime()) / 1000);
      return {
        name: row.name,
        status: row.status,
        lastSeenAt: row.lastSeenAt,
        lastSuccessAt: row.lastSuccessAt,
        secondsSinceSeen,
        isStale: secondsSinceSeen > row.staleAfterSeconds,
        staleAfterSeconds: row.staleAfterSeconds,
        lastDurationMs: row.lastDurationMs,
        lastError: row.lastError,
        runCount: row.runCount,
        failureCount: row.failureCount,
      };
    });
  }

  /** Just the worker, for the health endpoint. Null when it has never run. */
  async worker(): Promise<HeartbeatView | null> {
    return (await this.list()).find((h) => h.name === WORKER_SIGNAL) ?? null;
  }

  /** Signals that have gone quiet, or whose last run failed. */
  async unhealthy(): Promise<HeartbeatView[]> {
    return (await this.list()).filter((h) => h.isStale || h.status === 'FAILED');
  }
}
