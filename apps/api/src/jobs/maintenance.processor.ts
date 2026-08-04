import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { QUEUE_NAMES } from '@hixaa/contracts';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { MailService } from '../infrastructure/mail/mail.service';
import { OutboxDispatcherService } from '../infrastructure/outbox/outbox-dispatcher.service';

/** Depth above which a queue backlog is treated as a problem worth an alert. */
const QUEUE_DEPTH_ALERT_THRESHOLD = 500;

/**
 * Housekeeping and self-monitoring.
 *
 * Everything here exists because an unattended single-VPS deployment has to
 * notice its own problems: a silently stalled queue, an outbox row stuck in
 * PROCESSING after a crash, tables growing without bound.
 */
@Injectable()
@Processor(QUEUE_NAMES.MAINTENANCE)
export class MaintenanceProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: AppConfigService,
    private readonly dispatcher: OutboxDispatcherService,
    private readonly logger: PinoLogger,
    @InjectQueue(QUEUE_NAMES.EMAIL) private readonly emailQueue: Queue,
  ) {
    super();
    this.logger.setContext(MaintenanceProcessor.name);
  }

  async process(job: Job): Promise<void> {
    this.logger.debug({ name: job.name }, 'Maintenance job');
  }

  /**
   * Recovers outbox rows abandoned mid-dispatch by a killed worker. Without
   * this they stay in PROCESSING forever, invisible to a poll that only looks
   * at PENDING and FAILED.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async recoverStuckOutboxEvents(): Promise<void> {
    if (!this.config.queue.workerEnabled) return;
    await OutboxDispatcherService.asSystem('outbox-recovery', async () => {
      await this.dispatcher.recoverStuck();
    });
  }

  /** Alerts on queue backlog and dead letters. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async monitorQueues(): Promise<void> {
    if (!this.config.queue.workerEnabled) return;

    try {
      const [waiting, failed] = await Promise.all([
        this.emailQueue.getWaitingCount(),
        this.emailQueue.getFailedCount(),
      ]);

      if (waiting > QUEUE_DEPTH_ALERT_THRESHOLD || failed > 0) {
        await this.mail.sendOps('queue-alert', {
          queue: QUEUE_NAMES.EMAIL,
          depth: waiting,
          deadLetterCount: failed,
        });
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Queue monitoring failed');
    }
  }

  /**
   * Purges rows whose retention has elapsed.
   *
   * `audit_log` is excluded on purpose — it is append-only and its retention is
   * handled by detaching partitions after backup, never by DELETE. The database
   * trigger from migration 0002 would reject the attempt anyway.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredRows(): Promise<void> {
    if (!this.config.queue.workerEnabled) return;

    await OutboxDispatcherService.asSystem('retention-purge', async () => {
      const now = new Date();
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000);

      try {
        const [sessions, resetTokens, verifyTokens, idempotency, outbox, emails] =
          await Promise.all([
            this.prisma.db.session.deleteMany({ where: { expiresAt: { lt: now } } }),
            this.prisma.db.passwordResetToken.deleteMany({ where: { expiresAt: { lt: now } } }),
            this.prisma.db.emailVerificationToken.deleteMany({ where: { expiresAt: { lt: now } } }),
            this.prisma.db.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } }),
            this.prisma.db.outboxEvent.deleteMany({
              where: { status: 'PROCESSED', processedAt: { lt: ninetyDaysAgo } },
            }),
            this.prisma.db.emailLog.deleteMany({
              where: { status: 'SENT', createdAt: { lt: ninetyDaysAgo } },
            }),
          ]);

        this.logger.info(
          {
            sessions: sessions.count,
            resetTokens: resetTokens.count,
            verifyTokens: verifyTokens.count,
            idempotency: idempotency.count,
            outbox: outbox.count,
            emails: emails.count,
          },
          'Retention purge complete',
        );
      } catch (error) {
        this.logger.error({ err: error }, 'Retention purge failed');
      }
    });
  }
}
