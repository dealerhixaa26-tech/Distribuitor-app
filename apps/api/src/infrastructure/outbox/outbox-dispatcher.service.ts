import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { EVENT_QUEUE_ROUTING, QUEUE_NAMES, type QueueName } from '@hixaa/contracts';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { RequestContextStore } from '../../common/context/request-context';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../database/prisma.service';

/** Attempts before a row is parked in DEAD and an ops alert is raised. */
export const MAX_ATTEMPTS = 5;

/** Upper bound on a single retry delay, so a long-dead consumer still retries hourly. */
const MAX_BACKOFF_MS = 3_600_000;

/**
 * Retry backoff: 1m, 2m, 4m, 8m, 16m, capped at one hour.
 *
 * Extracted as a pure function so the schedule is unit-tested directly rather
 * than inferred from timestamps in an integration test.
 */
export function backoffDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(60_000 * 2 ** exponent, MAX_BACKOFF_MS);
}

/** True once an event has exhausted its retries and should be parked as DEAD. */
export function isExhausted(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS;
}

interface ClaimedEvent {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  actor_user_id: string | null;
  request_id: string | null;
}

/**
 * Drains the outbox into BullMQ. Runs in the WORKER process only.
 *
 * The claim uses `FOR UPDATE SKIP LOCKED`, which is what makes this safe to run
 * on several workers at once: each poll grabs a disjoint batch instead of
 * competing for the same rows. Combined with the partial index from migration
 * 0002, the poll stays cheap no matter how much processed history accumulates.
 */
@Injectable()
export class OutboxDispatcherService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  private readonly queues: Record<QueueName, Queue>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
    @InjectQueue(QUEUE_NAMES.EMAIL) email: Queue,
    @InjectQueue(QUEUE_NAMES.NOTIFICATIONS) notifications: Queue,
    @InjectQueue(QUEUE_NAMES.SHEETS_SYNC) sheets: Queue,
    @InjectQueue(QUEUE_NAMES.REPORTS) reports: Queue,
    @InjectQueue(QUEUE_NAMES.MAINTENANCE) maintenance: Queue,
  ) {
    this.logger.setContext(OutboxDispatcherService.name);
    this.queues = {
      [QUEUE_NAMES.EMAIL]: email,
      [QUEUE_NAMES.NOTIFICATIONS]: notifications,
      [QUEUE_NAMES.SHEETS_SYNC]: sheets,
      [QUEUE_NAMES.REPORTS]: reports,
      [QUEUE_NAMES.MAINTENANCE]: maintenance,
    };
  }

  onModuleInit(): void {
    if (!this.config.queue.workerEnabled) {
      this.logger.info('Outbox dispatcher disabled (WORKER_ENABLED=false)');
      return;
    }
    this.schedule();
    this.logger.info(
      { intervalMs: this.config.outbox.pollIntervalMs, batchSize: this.config.outbox.batchSize },
      'Outbox dispatcher started',
    );
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, this.config.outbox.pollIntervalMs);
  }

  /** One poll cycle. Never throws — a failed cycle must not kill the loop. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      const claimed = await this.claim(this.config.outbox.batchSize);
      if (claimed.length === 0) return 0;

      let dispatched = 0;
      for (const event of claimed) {
        const ok = await this.dispatch(event);
        if (ok) dispatched++;
      }

      this.logger.debug({ claimed: claimed.length, dispatched }, 'Outbox batch processed');
      return dispatched;
    } catch (error) {
      this.logger.error({ err: error }, 'Outbox dispatch cycle failed');
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Atomically claims a batch, flipping PENDING/FAILED → PROCESSING.
   *
   * SKIP LOCKED means concurrent workers never block each other and never
   * process the same event twice.
   */
  private async claim(batchSize: number): Promise<ClaimedEvent[]> {
    return this.prisma.db.$queryRaw<ClaimedEvent[]>`
      WITH claimed AS (
        SELECT id
        FROM outbox_event
        WHERE status IN ('PENDING', 'FAILED')
          AND available_at <= now()
        ORDER BY available_at ASC, id ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_event AS o
      SET status = 'PROCESSING', attempts = o.attempts + 1
      FROM claimed
      WHERE o.id = claimed.id
      RETURNING o.id, o.event_type, o.aggregate_type, o.aggregate_id,
                o.payload, o.attempts, o.actor_user_id, o.request_id;
    `;
  }

  private async dispatch(event: ClaimedEvent): Promise<boolean> {
    const queueName = EVENT_QUEUE_ROUTING[event.event_type];

    if (!queueName) {
      // An event nobody consumes is not a failure — it is an event whose
      // consumer has not been built yet. Mark it processed and move on rather
      // than retrying it five times and parking it in the DLQ.
      await this.markProcessed(event.id);
      this.logger.debug({ eventType: event.event_type }, 'No queue route; marked processed');
      return true;
    }

    try {
      await this.queues[queueName].add(
        event.event_type,
        {
          eventId: event.id,
          eventType: event.event_type,
          aggregateType: event.aggregate_type,
          aggregateId: event.aggregate_id,
          payload: event.payload,
          actorUserId: event.actor_user_id,
          requestId: event.request_id,
        },
        {
          // The outbox row id is the job id, so a re-dispatched event after a
          // crash between enqueue and mark-processed is deduplicated by BullMQ
          // rather than delivered twice.
          jobId: event.id,
        },
      );

      await this.markProcessed(event.id);
      return true;
    } catch (error) {
      await this.markFailed(event, error);
      return false;
    }
  }

  private async markProcessed(id: string): Promise<void> {
    await this.prisma.db.outboxEvent.update({
      where: { id },
      data: { status: 'PROCESSED', processedAt: new Date(), lastError: null },
    });
  }

  private async markFailed(event: ClaimedEvent, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = isExhausted(event.attempts);
    const delayMs = backoffDelayMs(event.attempts);

    await this.prisma.db.outboxEvent.update({
      where: { id: event.id },
      data: {
        status: exhausted ? 'DEAD' : 'FAILED',
        lastError: message.slice(0, 1000),
        availableAt: exhausted ? undefined : new Date(Date.now() + delayMs),
      },
    });

    if (exhausted) {
      this.logger.error(
        { eventId: event.id, eventType: event.event_type, attempts: event.attempts, err: error },
        'Outbox event exhausted retries and was parked as DEAD',
      );
    } else {
      this.logger.warn(
        { eventId: event.id, eventType: event.event_type, attempts: event.attempts, delayMs },
        'Outbox dispatch failed; will retry',
      );
    }
  }

  /**
   * Re-queues rows stuck in PROCESSING — the signature of a worker killed
   * mid-dispatch. Without this they would sit invisible forever, since the poll
   * only looks at PENDING and FAILED.
   */
  async recoverStuck(olderThanMs = 300_000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.prisma.db.outboxEvent.updateMany({
      where: { status: 'PROCESSING', createdAt: { lt: cutoff } },
      data: { status: 'PENDING', availableAt: new Date() },
    });

    if (result.count > 0) {
      this.logger.warn({ count: result.count }, 'Recovered outbox events stuck in PROCESSING');
    }
    return result.count;
  }

  /** Runs `fn` as the system principal with a fresh correlation id. */
  static asSystem<T>(label: string, fn: () => T): T {
    return RequestContextStore.asSystem(label, randomUUID(), fn);
  }
}
