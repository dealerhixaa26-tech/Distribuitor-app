import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CronTime } from 'cron';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../common/utils/clock.service';
import { RequestContextStore } from '../common/context/request-context';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { MailService } from '../infrastructure/mail/mail.service';
import { OutboxDispatcherService } from '../infrastructure/outbox/outbox-dispatcher.service';
import { AccessService } from '../modules/auth/services/access.service';
import { JobHeartbeatService, STALE_AFTER } from '../modules/health/job-heartbeat.service';
import { ReportsService } from '../modules/intelligence/reports.service';

/** IST — the schedules are read by people in Nagpur. */
const TIMEZONE = 'Asia/Kolkata';

/** Guards a runaway sweep; a minute's worth of due reports is never this many. */
const MAX_PER_SWEEP = 20;

/**
 * Executes saved report schedules. The last piece Phase 9 left for Phase 10.
 *
 * `ReportDefinition` has stored `cronExpression`, `recipients` and
 * `isScheduleActive` since Phase 9, with a CHECK constraint refusing an active
 * schedule with no recipients — and nothing ever executed any of it.
 *
 * ── One sweeper, not a job per definition ──────────────────────────────────
 *
 * Definitions are DATA and change at runtime. Registering a `CronJob` per row
 * means a registry that must be kept in sync with a table — every create,
 * edit, delete and restore — and drift there is silent. A minute-by-minute
 * sweep over `nextRunAt` has one moving part and no synchronisation problem, at
 * a volume where the cost is irrelevant.
 *
 * ── ⚠️ Reports run as their OWNER, never as SYSTEM ──────────────────────────
 *
 * Since ADR-0021 a SYSTEM principal reads unscoped. That is correct for a
 * reconciliation sweep and catastrophic here: a territory-scoped manager's
 * monthly sales summary would be computed across every territory and then
 * EMAILED to them. So each report runs inside `RequestContextStore.asUser()`
 * with the owner's resolved access, seeing exactly what they would see running
 * it by hand.
 */
@Injectable()
export class ScheduledReportsProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly access: AccessService,
    private readonly mail: MailService,
    private readonly clock: ClockService,
    private readonly config: AppConfigService,
    private readonly heartbeat: JobHeartbeatService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ScheduledReportsProcessor.name);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    if (!this.config.queue.workerEnabled) return;

    await OutboxDispatcherService.asSystem('scheduled-reports', async () => {
      try {
        await this.heartbeat.track('scheduled-reports', STALE_AFTER.FREQUENT, () => this.runDue());
      } catch (error) {
        this.logger.error({ err: error }, 'Scheduled report sweep failed');
      }
    });
  }

  private async runDue(): Promise<void> {
    const now = this.clock.now();

    // Read unscoped: this sweep is looking across everyone's schedules, and it
    // is the only part that should. Each report is then run as its owner.
    const due = await RequestContextStore.withoutScope(() =>
      this.prisma.db.reportDefinition.findMany({
        where: {
          isScheduleActive: true,
          cronExpression: { not: null },
          deletedAt: null,
          OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
        },
        take: MAX_PER_SWEEP,
        select: {
          id: true,
          name: true,
          type: true,
          parameters: true,
          format: true,
          cronExpression: true,
          recipients: true,
          nextRunAt: true,
          createdById: true,
        },
      }),
    );

    if (due.length === 0) return;

    for (const definition of due) {
      /*
       * A definition whose nextRunAt is NULL has never been scheduled by this
       * runner — it was saved before the runner existed. Do not fire it
       * immediately: seed nextRunAt from its cron and let the next sweep pick
       * it up. Otherwise every historical schedule would blast out at once the
       * first time this deploys.
       */
      if (definition.nextRunAt === null) {
        await this.advance(definition.id, definition.cronExpression);
        this.logger.info(
          { definitionId: definition.id, name: definition.name },
          'Seeded nextRunAt for a schedule saved before the runner existed',
        );
        continue;
      }

      // Advanced BEFORE running. A report that throws must not be retried every
      // minute for the rest of the day — it waits for its next slot, and the
      // heartbeat records the failure.
      await this.advance(definition.id, definition.cronExpression);
      await this.runOne(definition);
    }
  }

  /** Computes the next fire time from the cron expression and stores it. */
  private async advance(id: string, expression: string | null): Promise<void> {
    try {
      const next = new CronTime(expression ?? '', TIMEZONE).sendAt().toJSDate();
      await RequestContextStore.withoutScope(() =>
        this.prisma.db.reportDefinition.update({ where: { id }, data: { nextRunAt: next } }),
      );
    } catch (error) {
      // The expression was validated at save time, so reaching here means it
      // has since become invalid. Deactivate rather than sweep over a broken
      // row every minute forever.
      this.logger.error(
        { err: error, definitionId: id, expression },
        'Invalid cron expression on an active schedule — deactivating it',
      );
      await RequestContextStore.withoutScope(() =>
        this.prisma.db.reportDefinition.update({
          where: { id },
          data: { isScheduleActive: false, nextRunAt: null },
        }),
      );
    }
  }

  private async runOne(definition: {
    id: string;
    name: string;
    type: string;
    parameters: unknown;
    format: string;
    recipients: string[];
    createdById: string | null;
  }): Promise<void> {
    if (definition.recipients.length === 0) {
      // The CHECK constraint should make this unreachable; if it happens, the
      // constraint has been weakened and that is worth knowing.
      this.logger.error(
        { definitionId: definition.id },
        'Active schedule with no recipients — the CHECK constraint should prevent this',
      );
      return;
    }

    if (!definition.createdById) {
      this.logger.error(
        { definitionId: definition.id },
        'Scheduled report has no owner; cannot resolve a scope to run it under',
      );
      return;
    }

    const access = await this.access.resolve(definition.createdById);

    // ⚠️ As the OWNER, not as SYSTEM. See the class comment — this is what
    // keeps a territory-scoped manager's report scoped to their territory.
    await RequestContextStore.asUser(
      {
        userId: definition.createdById,
        access,
        label: `scheduled-report:${definition.id}`,
        requestId: randomUUID(),
      },
      async () => {
        const result = await this.reports.run(
          {
            type: definition.type as never,
            parameters: definition.parameters,
            format: definition.format as never,
            definitionId: definition.id,
          },
          definition.createdById as string,
        );

        const rowCount = (result as { rowCount?: number }).rowCount ?? 0;
        const generatedAt = this.clock.now().toISOString().slice(0, 16).replace('T', ' ');

        // BUSINESS channel: recipients are partners and staff, never the ops
        // mailbox. The type system enforces it.
        for (const recipient of definition.recipients) {
          await this.mail.sendBusiness('report-ready', recipient, {
            name: recipient,
            reportName: definition.name,
            generatedAt,
            rowCount,
          });
        }

        this.logger.info(
          { definitionId: definition.id, recipients: definition.recipients.length, rowCount },
          'Scheduled report delivered',
        );
      },
    );
  }
}
