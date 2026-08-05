import { Injectable } from '@nestjs/common';
import { PERMISSIONS, type Permission } from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import { NotFoundError } from '../../common/errors/domain.error';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { PrismaTransaction } from '../../infrastructure/database/prisma.service';

/**
 * In-app notifications.
 *
 * ── Nothing new emits anything ─────────────────────────────────────────────
 * Every notification below is produced by consuming an event the outbox
 * ALREADY publishes — `order.approved`, `invoice.issued`, `payment.recorded`,
 * `stock.low`. ADR-0005 put every side effect through the outbox precisely so a
 * later phase could add a consumer without touching a producer, and Phase 9 is
 * the first phase to collect on that.
 *
 * ── Recipients are resolved by PERMISSION, not by a hardcoded list ─────────
 * "Who cares that stock is low" is answerable from the permission model:
 * whoever may act on it. A hardcoded recipient list would be wrong the first
 * time someone changed roles, and silently — the notification would simply stop
 * arriving for the person who now does the job.
 *
 * ── Delivery is in-app plus email, polled ──────────────────────────────────
 * `docs/08` specifies an SSE stream. That is deliberately NOT built here — see
 * docs/25 §7. SSE means a long-lived connection per user through Nginx on a
 * single VPS, with buffering, heartbeats and reconnect handling, to deliver
 * something whose value decays over minutes. A polled unread count is one
 * indexed query per user per 30 seconds and has no failure mode more
 * interesting than "the number updates late".
 */

/** Which permission makes someone a plausible recipient for an event. */
const EVENT_AUDIENCE: Record<string, Permission> = {
  'order.submitted': PERMISSIONS.ORDER_APPROVE,
  'order.approved': PERMISSIONS.ORDER_READ,
  'order.rejected': PERMISSIONS.ORDER_READ,
  'order.cancelled': PERMISSIONS.ORDER_READ,
  'shipment.dispatched': PERMISSIONS.ORDER_READ,
  'payment.recorded': PERMISSIONS.PAYMENT_VERIFY,
  'payment.verified': PERMISSIONS.PAYMENT_READ,
  'invoice.issued': PERMISSIONS.INVOICE_READ,
  'invoice.overdue': PERMISSIONS.PAYMENT_READ,
  'stock.low': PERMISSIONS.INVENTORY_ADJUST,
  'pricelist.published': PERMISSIONS.PRICELIST_READ,
  'distributor.catalog.changed': PERMISSIONS.DISTRIBUTOR_READ,
};

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationsService.name);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(userId: string, query: { unreadOnly?: boolean; limit: number }) {
    const notifications = await this.prisma.db.notification.findMany({
      where: { userId, ...(query.unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });

    return notifications.map((notification) => ({
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      priority: notification.priority,
      actionUrl: notification.actionUrl,
      isRead: notification.readAt !== null,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
    }));
  }

  /** The polled endpoint. One indexed count — see the note on SSE above. */
  async unreadCount(userId: string): Promise<{ unread: number }> {
    const unread = await this.prisma.db.notification.count({
      where: { userId, readAt: null },
    });
    return { unread };
  }

  async markRead(userId: string, id: string) {
    const notification = await this.prisma.db.notification.findFirst({
      where: { id, userId },
      select: { id: true, readAt: true },
    });
    if (!notification) throw new NotFoundError('Notification', id);

    // Idempotent: marking an already-read notification read again must not
    // move its timestamp, or "when did I see this" becomes unanswerable.
    if (notification.readAt) return { id, readAt: notification.readAt };

    const updated = await this.prisma.db.notification.update({
      where: { id },
      data: { readAt: this.clock.now() },
      select: { id: true, readAt: true },
    });
    return updated;
  }

  async markAllRead(userId: string): Promise<{ marked: number }> {
    const result = await this.prisma.db.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: this.clock.now() },
    });
    return { marked: result.count };
  }

  // ── Writes, called by the processor ───────────────────────────────────────

  /**
   * Fans one event out to everyone who may act on it.
   *
   * Idempotency matters: the outbox is at-least-once, so this can legitimately
   * run twice after a crash. Deduplicated on `(userId, type, aggregate id in
   * data)` within a short window rather than by a unique constraint, because
   * two genuinely separate low-stock events for the same product a week apart
   * are both worth sending.
   */
  async fanOut(
    tx: PrismaTransaction,
    input: {
      eventType: string;
      aggregateId: string;
      title: string;
      body: string;
      actionUrl?: string;
      priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
      excludeUserId?: string | null;
    },
  ): Promise<number> {
    const permission = EVENT_AUDIENCE[input.eventType];
    if (!permission) {
      this.logger.debug({ eventType: input.eventType }, 'No audience mapped — no notification');
      return 0;
    }

    const recipients = await this.usersWithPermission(tx, permission);
    // The person who caused the event does not need telling they did it.
    const targets = recipients.filter((id) => id !== input.excludeUserId);
    if (targets.length === 0) return 0;

    const since = new Date(this.clock.now().getTime() - 60_000);
    const alreadySent = await tx.notification.findMany({
      where: {
        userId: { in: targets },
        type: input.eventType,
        createdAt: { gte: since },
        data: { path: ['aggregateId'], equals: input.aggregateId },
      },
      select: { userId: true },
    });
    const sent = new Set(alreadySent.map((row) => row.userId));
    const fresh = targets.filter((id) => !sent.has(id));
    if (fresh.length === 0) return 0;

    await tx.notification.createMany({
      data: fresh.map((userId) => ({
        userId,
        type: input.eventType,
        title: input.title,
        body: input.body,
        priority: input.priority ?? 'NORMAL',
        actionUrl: input.actionUrl ?? null,
        data: { aggregateId: input.aggregateId } as Prisma.InputJsonValue,
      })),
    });

    return fresh.length;
  }

  /**
   * Everyone holding a permission, through any of their roles.
   *
   * Deliberately NOT scope-filtered here: a notification is about an aggregate
   * whose scope the recipient may or may not share, and filtering correctly
   * would mean resolving each candidate's territory subtree per event. The
   * notification carries only a title and a link — following that link goes
   * through the normal scoped read, which 404s if they may not see it.
   *
   * So the worst case is a notification that leads to a 404, not a leak. That
   * is a deliberate trade and the reason the body must never carry figures.
   */
  private async usersWithPermission(
    tx: PrismaTransaction,
    permission: Permission,
  ): Promise<string[]> {
    const assignments = await tx.userRole.findMany({
      where: {
        role: { permissions: { some: { permission: { key: permission } } } },
        user: { status: 'ACTIVE', deletedAt: null },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    return assignments.map((assignment) => assignment.userId);
  }
}
