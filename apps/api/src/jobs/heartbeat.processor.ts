import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { MailService } from '../infrastructure/mail/mail.service';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { OutboxDispatcherService } from '../infrastructure/outbox/outbox-dispatcher.service';
import {
  JobHeartbeatService,
  WORKER_BEAT_MS,
} from '../modules/health/job-heartbeat.service';

/**
 * The worker saying it is alive, and noticing when something else is not.
 *
 * This is the control that would have caught the defect that shaped this whole
 * phase: the worker did not boot between Phase 6 and Phase 9, and nothing
 * noticed, because a dead worker emits no error — it emits an absence. Nothing
 * was watching for an absence.
 */
@Injectable()
export class HeartbeatProcessor implements OnModuleInit {
  private readonly bootedAt = new Date();
  private readonly version = process.env.npm_package_version ?? 'dev';

  /** Signals already alerted on, so a stale job pages once, not every 5 min. */
  private readonly alerted = new Set<string>();

  constructor(
    private readonly heartbeat: JobHeartbeatService,
    private readonly mail: MailService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HeartbeatProcessor.name);
  }

  /**
   * Beat once at boot rather than waiting 30 seconds.
   *
   * A worker that dies during startup would otherwise never write a row at all,
   * and "no row" is ambiguous between "never deployed" and "died immediately" —
   * which is exactly the ambiguity that hid the original bug.
   */
  async onModuleInit(): Promise<void> {
    if (!this.config.queue.workerEnabled) return;
    await this.heartbeat.beat(this.bootedAt, this.version).catch((error: unknown) => {
      this.logger.error({ err: error }, 'Could not write the initial worker heartbeat');
    });
    this.logger.info({ bootedAt: this.bootedAt, version: this.version }, 'Worker heartbeat started');
  }

  @Interval(WORKER_BEAT_MS)
  async beat(): Promise<void> {
    if (!this.config.queue.workerEnabled) return;
    await this.heartbeat.beat(this.bootedAt, this.version).catch((error: unknown) => {
      this.logger.error({ err: error }, 'Heartbeat write failed');
    });
  }

  /**
   * The daily slow-query digest.
   *
   * The warnings already existed and went into a log nobody reads until
   * something is on fire. Their value is in the PATTERN — one query at 2.2s is
   * noise, the same query 400 times is a missing index — so they are aggregated
   * by shape and mailed once a day, ordered by total time cost.
   *
   * Sent only when there is something to say. A digest that arrives every
   * morning saying "nothing" is a digest people filter, and then the one that
   * matters is filtered too.
   */
  @Cron(CronExpression.EVERY_DAY_AT_7AM)
  async slowQueryDigest(): Promise<void> {
    if (!this.config.queue.workerEnabled) return;

    await OutboxDispatcherService.asSystem('slow-query-digest', async () => {
      try {
        const queries = this.prisma.drainSlowQueries(10);
        if (queries.length === 0) {
          this.logger.info('No slow queries in the last 24h');
          return;
        }

        this.logger.warn(
          { shapes: queries.length, worst: queries[0]?.shape },
          'Slow queries in the last 24h',
        );
        await this.mail.sendOps('slow-query-digest', {
          windowHours: 24,
          thresholdMs: this.config.database.slowQueryMs,
          queries,
        });
      } catch (error) {
        this.logger.error({ err: error }, 'Slow-query digest failed');
      }
    });
  }

  /**
   * Notices signals that have gone quiet or are failing.
   *
   * Alerts ONCE per signal per condition and clears when it recovers. A monitor
   * that repeats itself every five minutes is a monitor people filter, and a
   * filtered alert is the same as no alert.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkStaleSignals(): Promise<void> {
    if (!this.config.queue.workerEnabled) return;

    await OutboxDispatcherService.asSystem('heartbeat-check', async () => {
      try {
        const unhealthy = await this.heartbeat.unhealthy();
        const names = new Set(unhealthy.map((h) => h.name));

        for (const signal of unhealthy) {
          if (this.alerted.has(signal.name)) continue;
          this.alerted.add(signal.name);

          const detail = signal.isStale
            ? `Last reported ${signal.secondsSinceSeen}s ago, past its ` +
              `${signal.staleAfterSeconds}s threshold. Last success: ` +
              `${signal.lastSuccessAt?.toISOString() ?? 'never'}.`
            : `Last run FAILED: ${signal.lastError ?? 'no message'}`;

          this.logger.error({ signal: signal.name, detail }, 'Health signal unhealthy');
          await this.mail.sendOps('health-alert', {
            check: signal.name,
            consecutiveFailures: signal.failureCount,
            detail,
          });
        }

        // Recovered signals become alertable again.
        for (const name of [...this.alerted]) {
          if (!names.has(name)) {
            this.alerted.delete(name);
            this.logger.info({ signal: name }, 'Health signal recovered');
          }
        }
      } catch (error) {
        this.logger.error({ err: error }, 'Heartbeat check failed');
      }
    });
  }
}
