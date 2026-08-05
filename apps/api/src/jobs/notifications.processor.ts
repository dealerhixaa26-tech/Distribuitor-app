import { Processor, WorkerHost } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '@hixaa/contracts';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { RequestContextStore } from '../common/context/request-context';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { NotificationsService } from '../modules/intelligence/notifications.service';
import type { OutboxJobData } from './email.processor';

/**
 * Turns outbox events into in-app notifications.
 *
 * The routing table in `events.ts` has pointed these event types at
 * `QUEUE_NAMES.NOTIFICATIONS` since Phase 1; until now nothing consumed that
 * queue. Adding this processor required changing no producer, which is exactly
 * what ADR-0005 bought.
 *
 * ── Idempotent, because the outbox is at-least-once ────────────────────────
 * A job can legitimately run twice after a crash. `fanOut` deduplicates on
 * (user, event type, aggregate) within a minute, so a retry produces no second
 * notification while two genuinely separate events a week apart still both
 * arrive.
 *
 * ── Bodies carry no figures ────────────────────────────────────────────────
 * Recipients are resolved by permission but NOT by scope (see
 * NotificationsService), so a notification can reach someone who cannot open
 * the record it points at. Following the link goes through the normal scoped
 * read and 404s. That is only safe while the notification itself says nothing
 * — hence titles and references, never amounts.
 */
@Processor(QUEUE_NAMES.NOTIFICATIONS)
export class NotificationsProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(NotificationsProcessor.name);
  }

  async process(job: Job<OutboxJobData>): Promise<void> {
    const { eventType, payload, aggregateId, actorUserId, requestId } = job.data;

    await RequestContextStore.asSystem(
      `notify:${eventType}`,
      requestId ?? job.id ?? 'unknown',
      async () => {
        const message = this.describe(eventType, payload, aggregateId);
        if (!message) {
          this.logger.debug({ eventType }, 'No notification defined for this event');
          return;
        }

        const created = await this.prisma.transaction((tx) =>
          this.notifications.fanOut(tx, {
            eventType,
            aggregateId,
            title: message.title,
            body: message.body,
            actionUrl: message.actionUrl,
            priority: message.priority,
            excludeUserId: actorUserId,
          }),
        );

        if (created > 0) {
          this.logger.info({ eventType, created }, 'Notifications created');
        }
      },
    );
  }

  /**
   * The message for each event.
   *
   * Returns null for events with no in-app meaning, rather than inventing a
   * generic "something happened" — a notification nobody can act on trains
   * people to ignore the bell.
   */
  private describe(
    eventType: string,
    payload: Record<string, unknown>,
    aggregateId: string,
  ): { title: string; body: string; actionUrl?: string; priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' } | null {
    const text = (key: string): string => String(payload[key] ?? '');

    switch (eventType) {
      case 'order.submitted':
        return {
          title: 'Order awaiting approval',
          body: `Order ${text('number')} has been submitted and needs a decision.`,
          actionUrl: `/orders/${aggregateId}`,
          priority: 'HIGH',
        };
      case 'order.approved':
        return {
          title: 'Order approved',
          body: `Order ${text('number')} was approved.`,
          actionUrl: `/orders/${aggregateId}`,
        };
      case 'order.rejected':
        return {
          title: 'Order rejected',
          body: `Order ${text('number')} was rejected.`,
          actionUrl: `/orders/${aggregateId}`,
        };
      case 'shipment.dispatched':
        return {
          title: 'Shipment dispatched',
          body:
            `Shipment ${text('number')} left for order ${text('orderNumber')}` +
            (text('lrNumber') ? ` on LR ${text('lrNumber')}` : '') + '.',
          actionUrl: `/orders`,
        };
      case 'payment.recorded':
        return {
          title: 'Receipt awaiting verification',
          body:
            `Receipt ${text('number')} has been recorded and needs confirming by someone other ` +
            'than the person who recorded it.',
          actionUrl: `/payments`,
          priority: 'HIGH',
        };
      case 'payment.verified':
        return {
          title: 'Receipt verified',
          body: `Receipt ${text('number')} was verified and the ledger credited.`,
          actionUrl: `/payments`,
        };
      case 'invoice.issued':
        return {
          title: 'Tax invoice issued',
          body: `Invoice ${text('number')} was issued to ${text('counterparty')}.`,
          actionUrl: `/invoices/${aggregateId}`,
        };
      case 'invoice.overdue':
        return {
          title: 'Invoice overdue',
          body: `Invoice ${text('number')} has passed its due date.`,
          actionUrl: `/invoices/${aggregateId}`,
          priority: 'HIGH',
        };
      case 'stock.low':
        return {
          title: 'Stock below reorder level',
          body: `${text('sku')} has fallen to its reorder point at ${text('warehouseCode')}.`,
          actionUrl: `/inventory`,
          priority: 'HIGH',
        };
      case 'pricelist.published':
        return {
          title: 'Price list published',
          body: `Price list ${text('code')} is now live and changes what partners pay.`,
          actionUrl: `/price-lists`,
        };
      default:
        return null;
    }
  }
}
