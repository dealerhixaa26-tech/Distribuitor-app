import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DOMAIN_EVENTS, QUEUE_NAMES } from '@hixaa/contracts';
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
  /** Reported-once set, so a wiring bug is noticed rather than repeated. */
  private readonly reportedUnhandled = new Set<string>();

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
          /*
           * Routed here and unrecognised. This was a debug line, and it is how
           * `inventory.stock_low` was silently discarded: `describe()` matched
           * the literal 'stock.low' while the constant is 'inventory.stock_low',
           * so every low-stock alert fell through to `default` and vanished.
           *
           * Every case now matches on DOMAIN_EVENTS, and reaching this branch
           * means the routing table sends an event here that nobody described —
           * a wiring defect, reported once per process per type.
           */
          if (!this.reportedUnhandled.has(eventType)) {
            this.reportedUnhandled.add(eventType);
            this.logger.warn(
              { eventType },
              'Event routed to the notifications queue with NO HANDLER — it is being discarded',
            );
          }
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
      case DOMAIN_EVENTS.ORDER_SUBMITTED:
        return {
          title: 'Order awaiting approval',
          body: `Order ${text('number')} has been submitted and needs a decision.`,
          actionUrl: `/orders/${aggregateId}`,
          priority: 'HIGH',
        };
      case DOMAIN_EVENTS.ORDER_APPROVED:
        return {
          title: 'Order approved',
          body: `Order ${text('number')} was approved.`,
          actionUrl: `/orders/${aggregateId}`,
        };
      case DOMAIN_EVENTS.ORDER_REJECTED:
        return {
          title: 'Order rejected',
          body: `Order ${text('number')} was rejected.`,
          actionUrl: `/orders/${aggregateId}`,
        };
      case DOMAIN_EVENTS.SHIPMENT_DISPATCHED:
        return {
          title: 'Shipment dispatched',
          body:
            `Shipment ${text('number')} left for order ${text('orderNumber')}` +
            (text('lrNumber') ? ` on LR ${text('lrNumber')}` : '') + '.',
          actionUrl: `/orders`,
        };
      case DOMAIN_EVENTS.PAYMENT_RECORDED:
        return {
          title: 'Receipt awaiting verification',
          body:
            `Receipt ${text('number')} has been recorded and needs confirming by someone other ` +
            'than the person who recorded it.',
          actionUrl: `/payments`,
          priority: 'HIGH',
        };
      case DOMAIN_EVENTS.PAYMENT_VERIFIED:
        return {
          title: 'Receipt verified',
          body: `Receipt ${text('number')} was verified and the ledger credited.`,
          actionUrl: `/payments`,
        };
      /*
       * Currently UNREACHABLE: `invoice.issued` routes to the EMAIL queue,
       * because the counterparty needs the PDF. An event routes to exactly one
       * queue, so this case never runs. Kept, and labelled, because deleting it
       * would lose the decision — if fan-out to several queues is ever added,
       * this is the intended message.
       */
      case DOMAIN_EVENTS.INVOICE_ISSUED:
        return {
          title: 'Tax invoice issued',
          body: `Invoice ${text('number')} was issued to ${text('counterparty')}.`,
          actionUrl: `/invoices/${aggregateId}`,
        };
      case DOMAIN_EVENTS.INVOICE_OVERDUE:
        return {
          title: 'Invoice overdue',
          body: `Invoice ${text('number')} has passed its due date.`,
          actionUrl: `/invoices/${aggregateId}`,
          priority: 'HIGH',
        };
      case DOMAIN_EVENTS.STOCK_LOW:
        return {
          title: 'Stock below reorder level',
          body: `${text('sku')} has fallen to its reorder point at ${text('warehouseCode')}.`,
          actionUrl: `/inventory`,
          priority: 'HIGH',
        };
      case DOMAIN_EVENTS.PRICE_LIST_PUBLISHED:
        return {
          title: 'Price list published',
          body: `Price list ${text('code')} is now live and changes what partners pay.`,
          actionUrl: `/price-lists`,
        };

      // ── Channel ──────────────────────────────────────────────────────────
      case DOMAIN_EVENTS.DISTRIBUTOR_CATALOG_CHANGED:
        return {
          title: 'Distributor catalog changed',
          body: `The assigned catalog for ${text('code') || 'a distributor'} was updated.`,
          actionUrl: `/distributors/${aggregateId}`,
        };
      case DOMAIN_EVENTS.DISTRIBUTOR_SUSPENDED:
        return {
          title: 'Distributor suspended',
          body: `${text('legalName') || text('code')} was suspended and can no longer transact.`,
          actionUrl: `/distributors/${aggregateId}`,
          priority: 'HIGH',
        };
      case DOMAIN_EVENTS.DISTRIBUTOR_DOCUMENT_EXPIRING:
        return {
          title: 'Distributor document expiring',
          body: `A compliance document for ${text('code')} expires on ${text('expiresOn')}.`,
          actionUrl: `/distributors/${aggregateId}`,
          priority: 'HIGH',
        };
      case DOMAIN_EVENTS.DISTRIBUTOR_CREDIT_LIMIT_CHANGED:
        return {
          title: 'Credit limit changed',
          body: `The credit limit for ${text('code')} was changed.`,
          actionUrl: `/distributors/${aggregateId}`,
        };

      // ── Sales & finance ──────────────────────────────────────────────────
      case DOMAIN_EVENTS.QUOTATION_ACCEPTED:
        return {
          title: 'Quotation accepted',
          body: `Quotation ${text('number')} was accepted and can be converted to an order.`,
          actionUrl: `/quotations/${aggregateId}`,
          priority: 'HIGH',
        };
      case DOMAIN_EVENTS.ORDER_CANCELLED:
        return {
          title: 'Order cancelled',
          body: `Order ${text('number')} was cancelled; any reserved stock has been released.`,
          actionUrl: `/orders/${aggregateId}`,
        };
      case DOMAIN_EVENTS.SHIPMENT_DELIVERED:
        return {
          title: 'Shipment delivered',
          body: `Shipment ${text('number')} was marked delivered.`,
          actionUrl: `/orders`,
        };
      case DOMAIN_EVENTS.CREDIT_LIMIT_BREACHED:
        return {
          title: 'Credit limit breached',
          body: `${text('counterparty') || 'A party'} is over its credit limit.`,
          actionUrl: `/outstanding`,
          priority: 'URGENT',
        };

      default:
        return null;
    }
  }
}
