import { Injectable } from '@nestjs/common';
import {
  Money,
  canTransitionReservation,
  type CreateReservationDto,
  type ReservationStatus,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import { ConflictError, NotFoundError } from '../../common/errors/domain.error';
import { keysetWhere, toListResult } from '../../common/utils/pagination.util';
import { AuditService } from '../../infrastructure/database/audit.service';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../infrastructure/database/prisma.service';
import { StockLedgerService } from './stock-ledger.service';

/**
 * Reservations — stock committed to an approved order but not yet issued.
 *
 * ── The distinction that matters ───────────────────────────────────────────
 * Reserving does NOT move stock. The goods are still on the shelf, so no ledger
 * row is written; only `stock_balance.quantity_reserved` changes, and therefore
 * `quantity_available` falls. Writing a ledger row for a reservation would make
 * the ledger's sum stop matching on-hand, which is precisely the drift the
 * nightly reconciliation job hunts for.
 *
 * Consuming a reservation is different: that is a real dispatch, so it releases
 * the reservation AND posts an ISSUE movement, in one transaction.
 *
 * Phase 7 owns the triggers (approve → reserve, cancel → release, ship →
 * consume). Phase 6 owns the operations and enforces their correctness.
 */
const RESERVATION_SELECT = {
  id: true,
  warehouseId: true,
  productId: true,
  variantId: true,
  orderId: true,
  quantity: true,
  status: true,
  expiresAt: true,
  releasedAt: true,
  consumedAt: true,
  notes: true,
  createdAt: true,
  warehouse: { select: { code: true, name: true } },
  product: { select: { sku: true, name: true } },
} satisfies Prisma.StockReservationSelect;

type ReservationRow = Prisma.StockReservationGetPayload<{ select: typeof RESERVATION_SELECT }>;

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: StockLedgerService,
    private readonly audit: AuditService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReservationsService.name);
  }

  async list(query: {
    warehouseId?: string;
    productId?: string;
    orderId?: string;
    status?: ReservationStatus;
    cursor?: string;
    limit: number;
    includeTotal: boolean;
  }) {
    const where: Prisma.StockReservationWhereInput = {
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const cursorWhere = keysetWhere(query.cursor);
    const rows = await this.prisma.db.stockReservation.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: RESERVATION_SELECT,
    });

    const totalCount = query.includeTotal
      ? await this.prisma.db.stockReservation.count({ where })
      : undefined;

    const result = toListResult(rows, query.limit, totalCount);
    return { ...result, data: result.data.map(toSummary) };
  }

  /**
   * Holds stock. Refused when insufficient is AVAILABLE — not merely on hand,
   * since stock already promised to another order is not available to this one.
   */
  async reserve(dto: CreateReservationDto, actorId: string) {
    await this.assertWarehouseVisible(dto.warehouseId);

    const created = await this.prisma.transaction(async (tx) => {
      // Takes the same row lock as a movement, so a reservation and a dispatch
      // racing for the last unit serialise against each other rather than both
      // succeeding.
      await this.ledger.adjustReserved(tx, {
        warehouseId: dto.warehouseId,
        productId: dto.productId,
        variantId: dto.variantId ?? null,
        delta: dto.quantity,
      });

      const reservation = await tx.stockReservation.create({
        data: {
          warehouseId: dto.warehouseId,
          productId: dto.productId,
          variantId: dto.variantId ?? null,
          orderId: dto.orderId ?? null,
          quantity: dto.quantity,
          status: 'ACTIVE',
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          notes: dto.notes ?? null,
          createdById: actorId,
        },
        select: RESERVATION_SELECT,
      });

      await this.audit.record(tx, {
        action: 'inventory.stock_reserved',
        entityType: 'StockReservation',
        entityId: reservation.id,
        after: {
          warehouseId: dto.warehouseId,
          productId: dto.productId,
          quantity: dto.quantity,
          orderId: dto.orderId ?? null,
        },
      });

      return reservation;
    });

    return toSummary(created);
  }

  /** Gives the stock back. No ledger row — nothing physically moved. */
  async release(id: string, actorId: string) {
    return this.close(id, 'RELEASED', actorId);
  }

  /**
   * Draws PART of a reservation down as goods actually ship.
   *
   * A shipment rarely matches a reservation exactly — a line reserved for 10
   * may go out as 4 now and 6 later. `consume()` handles the whole-reservation
   * case; this handles the partial one, and both release the hold AND post the
   * ISSUE in the same transaction for the same reason: stock must never be
   * decremented without its reservation clearing, nor the reverse.
   *
   * The reservation's quantity is reduced as it is drawn down and the row is
   * marked CONSUMED only when nothing remains. History is not lost by that —
   * the LEDGER is the source of truth for what moved, and it has a row per
   * shipment.
   */
  async consumeQuantity(
    tx: PrismaTransaction,
    input: {
      orderId: string;
      warehouseId: string;
      productId: string;
      variantId?: string | null;
      quantity: string;
      refType?: string;
      refId?: string;
      actorId: string;
    },
  ): Promise<{ remaining: string }> {
    const reservation = await tx.stockReservation.findFirst({
      where: {
        orderId: input.orderId,
        warehouseId: input.warehouseId,
        productId: input.productId,
        variantId: input.variantId ?? null,
        status: 'ACTIVE',
      },
      select: { id: true, quantity: true },
    });

    if (!reservation) {
      // Invariant 2 of docs/00 §4.2: stock cannot be dispatched that is not on
      // hand AND reserved. No reservation means this quantity was never
      // committed to this order — most likely it is backordered.
      throw new ConflictError(
        'No active reservation covers this dispatch. Stock can only be dispatched against ' +
          'stock that was reserved for this order — a backordered line cannot ship until ' +
          'the stock arrives and is reserved.',
      );
    }

    const held = Money.of(reservation.quantity.toFixed(4));
    const wanted = Money.of(input.quantity);

    if (wanted.gt(held)) {
      throw new ConflictError(
        `Cannot dispatch ${wanted.toDisplayString()} — only ${held.toDisplayString()} is ` +
          'reserved for this order line.',
      );
    }

    await this.ledger.adjustReserved(tx, {
      warehouseId: input.warehouseId,
      productId: input.productId,
      variantId: input.variantId ?? null,
      delta: wanted.negate().toString(),
    });

    await this.ledger.move(tx, {
      warehouseId: input.warehouseId,
      productId: input.productId,
      variantId: input.variantId ?? null,
      movementType: 'ISSUE',
      quantity: wanted.toString(),
      refType: input.refType ?? 'SHIPMENT',
      refId: input.refId ?? input.orderId,
      actorId: input.actorId,
    });

    const remaining = held.subtract(wanted);

    await tx.stockReservation.update({
      where: { id: reservation.id },
      data: {
        quantity: remaining.toString(),
        ...(remaining.isZero()
          ? { status: 'CONSUMED' as const, consumedAt: this.clock.now() }
          : {}),
      },
    });

    return { remaining: remaining.toString() };
  }

  /** Sweeps a stale hold so stock is not locked behind a dead order. */
  async expire(id: string, actorId: string) {
    return this.close(id, 'EXPIRED', actorId);
  }

  /**
   * Consumes a reservation: the goods actually ship.
   *
   * Releases the hold AND posts the ISSUE movement in one transaction, so stock
   * can never be decremented without its reservation being cleared, nor the
   * reverse — which would leave `quantity_reserved` permanently overstated and
   * silently shrink everything the warehouse could sell.
   */
  async consume(id: string, actorId: string) {
    const reservation = await this.load(id);
    this.assertTransition(reservation.status, 'CONSUMED');

    const consumed = await this.prisma.transaction(async (tx) => {
      await this.ledger.adjustReserved(tx, {
        warehouseId: reservation.warehouseId,
        productId: reservation.productId,
        variantId: reservation.variantId,
        delta: Money.of(reservation.quantity.toFixed(4)).negate().toString(),
      });

      await this.ledger.move(tx, {
        warehouseId: reservation.warehouseId,
        productId: reservation.productId,
        variantId: reservation.variantId,
        movementType: 'ISSUE',
        quantity: reservation.quantity.toFixed(4),
        refType: 'RESERVATION',
        refId: reservation.id,
        actorId,
      });

      const result = await tx.stockReservation.update({
        where: { id },
        data: { status: 'CONSUMED', consumedAt: this.clock.now() },
        select: RESERVATION_SELECT,
      });

      await this.audit.record(tx, {
        action: 'inventory.reservation_consumed',
        entityType: 'StockReservation',
        entityId: id,
        before: { status: reservation.status },
        after: { status: 'CONSUMED' },
        metadata: { actorId },
      });

      return result;
    });

    return toSummary(consumed);
  }

  /**
   * Expires everything past its date. Run by the maintenance job.
   *
   * One transaction per reservation rather than one for all: a single stuck row
   * must not block the whole sweep, and each release is independent.
   */
  async expireStale(): Promise<number> {
    const stale = await this.prisma.db.stockReservation.findMany({
      where: { status: 'ACTIVE', expiresAt: { not: null, lte: this.clock.now() } },
      select: { id: true },
      take: 500,
    });

    let expired = 0;
    for (const row of stale) {
      try {
        await this.close(row.id, 'EXPIRED', null);
        expired++;
      } catch (error) {
        this.logger.error({ err: error, reservationId: row.id }, 'Failed to expire reservation');
      }
    }

    if (expired > 0) this.logger.info({ expired }, 'Stale reservations expired');
    return expired;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async close(id: string, to: 'RELEASED' | 'EXPIRED', actorId: string | null) {
    const reservation = await this.load(id);
    this.assertTransition(reservation.status, to);

    const updated = await this.prisma.transaction(async (tx) => {
      await this.ledger.adjustReserved(tx, {
        warehouseId: reservation.warehouseId,
        productId: reservation.productId,
        variantId: reservation.variantId,
        delta: Money.of(reservation.quantity.toFixed(4)).negate().toString(),
      });

      const result = await tx.stockReservation.update({
        where: { id },
        data: { status: to, releasedAt: this.clock.now() },
        select: RESERVATION_SELECT,
      });

      await this.audit.record(tx, {
        action: to === 'RELEASED' ? 'inventory.reservation_released' : 'inventory.reservation_expired',
        entityType: 'StockReservation',
        entityId: id,
        before: { status: reservation.status },
        after: { status: to },
        metadata: { actorId },
      });

      return result;
    });

    return toSummary(updated);
  }

  private async load(id: string) {
    const reservation = await this.prisma.db.stockReservation.findFirst({
      where: { id },
      select: {
        id: true,
        warehouseId: true,
        productId: true,
        variantId: true,
        quantity: true,
        status: true,
      },
    });
    if (!reservation) throw new NotFoundError('StockReservation', id);
    return reservation;
  }

  private assertTransition(from: ReservationStatus, to: ReservationStatus): void {
    if (!canTransitionReservation(from, to)) {
      throw new ConflictError(
        `A ${from} reservation cannot become ${to}. A reservation leaves ACTIVE exactly once — ` +
          're-activating one that has already shipped would double-count the stock.',
      );
    }
  }

  private async assertWarehouseVisible(warehouseId: string): Promise<void> {
    const warehouse = await this.prisma.db.warehouse.findFirst({
      where: { id: warehouseId },
      select: { id: true },
    });
    if (!warehouse) throw new NotFoundError('Warehouse', warehouseId);
  }
}

function toSummary(row: ReservationRow) {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouse.code,
    productId: row.productId,
    sku: row.product.sku,
    productName: row.product.name,
    variantId: row.variantId,
    orderId: row.orderId,
    quantity: row.quantity.toFixed(4),
    status: row.status,
    expiresAt: row.expiresAt,
    releasedAt: row.releasedAt,
    consumedAt: row.consumedAt,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}
