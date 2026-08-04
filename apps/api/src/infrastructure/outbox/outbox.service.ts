import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { RequestContextStore } from '../../common/context/request-context';
import type { PrismaTransaction } from '../database/prisma.service';

/**
 * Transactional outbox emitter. See ADR-0005.
 *
 * `emit()` takes the transaction client as its first argument and nothing else
 * will do — that is the whole point. The event row commits with the business
 * change or disappears with it, so there is no state in which an email
 * announces an order that does not exist.
 */
@Injectable()
export class OutboxService {
  /**
   * Records an event inside the caller's transaction.
   *
   * @param tx  The transaction client. Passing the non-transactional client
   *            would reintroduce exactly the dual-write problem this solves.
   */
  async emit(
    tx: PrismaTransaction,
    eventType: DomainEvent,
    aggregate: { type: string; id: string },
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    const context = RequestContextStore.get();

    await tx.outboxEvent.create({
      data: {
        aggregateType: aggregate.type,
        aggregateId: aggregate.id,
        eventType,
        payload: payload as Prisma.InputJsonValue,
        status: 'PENDING',
        actorUserId: context?.userId ?? null,
        requestId: context?.requestId ?? null,
      },
    });
  }

  /** Emits several events atomically — one order approval may fan out. */
  async emitMany(
    tx: PrismaTransaction,
    events: Array<{
      eventType: DomainEvent;
      aggregate: { type: string; id: string };
      payload?: Record<string, unknown>;
    }>,
  ): Promise<void> {
    if (events.length === 0) return;
    const context = RequestContextStore.get();

    await tx.outboxEvent.createMany({
      data: events.map((event) => ({
        aggregateType: event.aggregate.type,
        aggregateId: event.aggregate.id,
        eventType: event.eventType,
        payload: (event.payload ?? {}) as Prisma.InputJsonValue,
        status: 'PENDING' as const,
        actorUserId: context?.userId ?? null,
        requestId: context?.requestId ?? null,
      })),
    });
  }
}
