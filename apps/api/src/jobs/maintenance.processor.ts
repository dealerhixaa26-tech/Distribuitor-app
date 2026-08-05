import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { QUEUE_NAMES, type QueueName } from '@hixaa/contracts';
import type { Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { MailService } from '../infrastructure/mail/mail.service';
import { OutboxDispatcherService } from '../infrastructure/outbox/outbox-dispatcher.service';


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
  /** Every queue, so monitoring covers all five rather than only email. */
  private readonly queues: Record<QueueName, Queue>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: AppConfigService,
    private readonly dispatcher: OutboxDispatcherService,
    private readonly logger: PinoLogger,
    @InjectQueue(QUEUE_NAMES.EMAIL) email: Queue,
    @InjectQueue(QUEUE_NAMES.NOTIFICATIONS) notifications: Queue,
    @InjectQueue(QUEUE_NAMES.SHEETS_SYNC) sheets: Queue,
    @InjectQueue(QUEUE_NAMES.REPORTS) reports: Queue,
    @InjectQueue(QUEUE_NAMES.MAINTENANCE) maintenance: Queue,
  ) {
    super();
    this.logger.setContext(MaintenanceProcessor.name);
    this.queues = {
      [QUEUE_NAMES.EMAIL]: email,
      [QUEUE_NAMES.NOTIFICATIONS]: notifications,
      [QUEUE_NAMES.SHEETS_SYNC]: sheets,
      [QUEUE_NAMES.REPORTS]: reports,
      [QUEUE_NAMES.MAINTENANCE]: maintenance,
    };
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

  /**
   * Alerts on queue backlog and dead letters, across EVERY queue.
   *
   * This watched the email queue alone — one of five. A stalled
   * `notifications`, `reports`, `sheets-sync` or `maintenance` queue was
   * invisible, which for `sheets-sync` would have meant a backup queue silently
   * filling up while the thing meant to notice it looked elsewhere.
   *
   * Each queue is checked independently so one unreachable queue does not
   * suppress the alert for the other four.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async monitorQueues(): Promise<void> {
    if (!this.config.queue.workerEnabled) return;

    const threshold = this.config.queue.depthAlertThreshold;

    for (const [name, queue] of Object.entries(this.queues)) {
      try {
        const [waiting, failed] = await Promise.all([
          queue.getWaitingCount(),
          queue.getFailedCount(),
        ]);

        if (waiting > threshold || failed > 0) {
          this.logger.warn({ queue: name, waiting, failed }, 'Queue backlog or dead letters');
          await this.mail.sendOps('queue-alert', {
            queue: name,
            depth: waiting,
            deadLetterCount: failed,
          });
        }
      } catch (error) {
        this.logger.error({ err: error, queue: name }, 'Queue monitoring failed for this queue');
      }
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
