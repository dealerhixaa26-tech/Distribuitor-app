import { Injectable } from '@nestjs/common';
import {
  DOMAIN_EVENTS,
  Money,
  canTransitionShipment,
  type CreateShipmentDto,
  type DispatchShipmentDto,
  type ShipmentStatus,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import { ConflictError, NotFoundError } from '../../common/errors/domain.error';
import { keysetWhere, toListResult } from '../../common/utils/pagination.util';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { NumberSequenceService } from '../distributors/number-sequence.service';
import { ReservationsService } from '../inventory/reservations.service';
import { SerialsService } from '../inventory/serials.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { WarehousesService } from '../inventory/warehouses.service';
import { OrdersService } from './orders.service';

/**
 * Shipments — where invariant 2 bites and channel inventory becomes real.
 *
 * ── The two things dispatch must get right ─────────────────────────────────
 *
 * 1. **Nothing ships that was not reserved** (`docs/00` §4.2 invariant 2).
 *    Enforced by drawing down the order's reservation rather than by checking a
 *    number: `ReservationsService.consumeQuantity()` refuses outright when no
 *    reservation covers the quantity, which is exactly the backordered case.
 *
 * 2. **A sell-in dispatch MOVES stock, it does not destroy it** (ADR-0014).
 *    Two ledger movements, one transaction:
 *
 *        ISSUE   −qty  Hixaa's warehouse        (consumes the reservation)
 *        RECEIPT +qty  the distributor's warehouse  ← channel inventory
 *
 *    A sell-out dispatch posts only the ISSUE, out of the partner's warehouse —
 *    the goods leave the channel entirely at that point.
 */
const SHIPMENT_SELECT = {
  id: true,
  number: true,
  orderId: true,
  status: true,
  warehouseId: true,
  carrierName: true,
  lrNumber: true,
  vehicleNumber: true,
  dispatchedAt: true,
  deliveredAt: true,
  createdAt: true,
  order: { select: { number: true, type: true, distributorId: true } },
  warehouse: { select: { code: true } },
  lines: { select: { quantity: true } },
} satisfies Prisma.ShipmentSelect;

type ShipmentRow = Prisma.ShipmentGetPayload<{ select: typeof SHIPMENT_SELECT }>;

@Injectable()
export class ShipmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly reservations: ReservationsService,
    private readonly ledger: StockLedgerService,
    private readonly serials: SerialsService,
    private readonly warehouses: WarehousesService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly sequences: NumberSequenceService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ShipmentsService.name);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(query: {
    orderId?: string;
    status?: ShipmentStatus;
    warehouseId?: string;
    cursor?: string;
    limit: number;
    includeTotal: boolean;
  }) {
    const where: Prisma.ShipmentWhereInput = {
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
    };

    const cursorWhere = keysetWhere(query.cursor);
    const rows = await this.prisma.db.shipment.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: SHIPMENT_SELECT,
    });

    const totalCount = query.includeTotal
      ? await this.prisma.db.shipment.count({ where })
      : undefined;

    const result = toListResult(rows, query.limit, totalCount);
    return { ...result, data: result.data.map(toSummary) };
  }

  async findDetail(id: string) {
    const shipment = await this.prisma.db.shipment.findFirst({
      where: { id },
      select: SHIPMENT_SELECT,
    });
    if (!shipment) throw new NotFoundError('Shipment', id);

    const lines = await this.prisma.db.shipmentLine.findMany({
      where: { shipmentId: id },
      select: {
        id: true,
        quantity: true,
        serials: true,
        orderLine: {
          select: { id: true, lineNumber: true, sku: true, description: true, quantity: true },
        },
      },
    });

    return {
      ...toSummary(shipment),
      lines: lines.map((line) => ({
        id: line.id,
        orderLineId: line.orderLine.id,
        lineNumber: line.orderLine.lineNumber,
        sku: line.orderLine.sku,
        description: line.orderLine.description,
        orderedQuantity: line.orderLine.quantity.toFixed(4),
        quantity: line.quantity.toFixed(4),
        serials: line.serials,
      })),
    };
  }

  // ── Create ────────────────────────────────────────────────────────────────

  /**
   * Builds a shipment from order lines.
   *
   * Validates against RESERVED quantities up front, outside the transaction, so
   * an obviously impossible pick is refused without taking row locks. The
   * authoritative check still happens at dispatch, under the lock — this is a
   * fast failure, not the control.
   */
  async create(dto: CreateShipmentDto, actorId: string) {
    const order = await this.loadOrder(dto.orderId);

    if (!['APPROVED', 'PROCESSING', 'PARTIALLY_DISPATCHED'].includes(order.status)) {
      throw new ConflictError(
        `Order ${order.number} is ${order.status}. Only an approved order can be shipped.`,
      );
    }

    const orderLines = new Map(order.lines.map((line) => [line.id, line]));

    for (const line of dto.lines) {
      const orderLine = orderLines.get(line.orderLineId);
      if (!orderLine) throw new NotFoundError('Order line', line.orderLineId);

      const wanted = Money.of(line.quantity);
      const reserved = Money.of(orderLine.quantityReserved.toFixed(4));
      const alreadyShipped = Money.of(orderLine.quantityDispatched.toFixed(4));
      const remaining = Money.of(orderLine.quantity.toFixed(4)).subtract(alreadyShipped);

      if (wanted.gt(remaining)) {
        throw new ConflictError(
          `${orderLine.sku}: cannot ship ${wanted.toDisplayString()} — only ` +
            `${remaining.toDisplayString()} of the ordered quantity is still outstanding.`,
        );
      }

      // ADR-0012 §3: dispatch is blocked PER LINE. This is the message a user
      // needs — not "insufficient stock", but "this part is backordered".
      if (wanted.gt(reserved)) {
        const backordered = Money.of(orderLine.quantityBackordered.toFixed(4));
        throw new ConflictError(
          `${orderLine.sku}: only ${reserved.toDisplayString()} is reserved and can ship. ` +
            `${backordered.toDisplayString()} is backordered` +
            (orderLine.expectedAvailableDate
              ? `, expected ${orderLine.expectedAvailableDate.toISOString().slice(0, 10)}.`
              : '.'),
        );
      }
    }

    const warehouseId = dto.warehouseId ?? order.warehouseId;
    if (!warehouseId) {
      throw new ConflictError('This order has no fulfilling warehouse.');
    }

    const created = await this.prisma.transaction(async (tx) => {
      const number = await this.sequences.next(tx, 'SHIPMENT');

      const shipment = await tx.shipment.create({
        data: {
          number,
          orderId: dto.orderId,
          status: 'PENDING',
          warehouseId,
          notes: dto.notes ?? null,
          createdById: actorId,
          lines: {
            createMany: {
              data: dto.lines.map((line) => ({
                orderLineId: line.orderLineId,
                quantity: line.quantity,
                serials: line.serials ?? [],
              })),
            },
          },
        },
        select: SHIPMENT_SELECT,
      });

      await this.orders.timelineEntry(tx, dto.orderId, {
        event: 'SHIPMENT_CREATED',
        description: `Shipment ${number} created with ${dto.lines.length} line(s)`,
        actorId,
      });

      await this.audit.record(tx, {
        action: 'shipment.created',
        entityType: 'Shipment',
        entityId: shipment.id,
        after: { number, orderNumber: order.number, lines: dto.lines.length },
      });

      return shipment;
    });

    return toSummary(created);
  }

  async pack(id: string, actorId: string) {
    const shipment = await this.load(id);
    this.assertTransition(shipment.status, 'PACKED', shipment.number);

    return this.simpleTransition(id, 'PACKED', actorId, {
      action: 'shipment.packed',
      data: { packedAt: this.clock.now() },
    });
  }

  // ── Dispatch — the operation this service exists for ───────────────────────

  /**
   * PACKED → DISPATCHED. Stock physically leaves.
   *
   * Everything happens in ONE transaction: reservations drawn down, stock
   * issued, channel stock received, serials recorded, order lines updated, and
   * the order's fulfilment status recomputed. A partial failure here would
   * leave stock issued against an order that does not know it shipped.
   */
  async dispatch(id: string, dto: DispatchShipmentDto, actorId: string) {
    const shipment = await this.load(id);
    this.assertTransition(shipment.status, 'DISPATCHED', shipment.number);

    const order = await this.loadOrder(shipment.orderId);
    const lines = await this.prisma.db.shipmentLine.findMany({
      where: { shipmentId: id },
      select: {
        id: true,
        quantity: true,
        serials: true,
        orderLine: {
          select: {
            id: true,
            productId: true,
            variantId: true,
            sku: true,
            unitPrice: true,
            quantityDispatched: true,
            product: { select: { isSerialized: true } },
          },
        },
      },
    });

    // ── Serials validated BEFORE anything moves (ADR-0009) ────────────────
    // A short list must fail the whole dispatch, not ship some units
    // untraceable. Checked outside the transaction so the obvious mistake
    // costs nothing.
    for (const line of lines) {
      if (!line.orderLine.product.isSerialized) continue;

      const expected = Money.of(line.quantity.toFixed(4));
      const supplied = line.serials.length;
      if (!Money.of(String(supplied)).equals(expected)) {
        throw new ConflictError(
          `${line.orderLine.sku} is serial-tracked: ${expected.toDisplayString()} unit(s) ` +
            `require exactly that many serial numbers, but ${supplied} were supplied.`,
        );
      }
    }

    const dispatchedAt = this.clock.now();

    const updated = await this.prisma.transaction(async (tx) => {
      // The receiving channel warehouse, provisioned on first dispatch to this
      // partner (ADR-0014 §1). Sell-out has no onward channel — the goods leave.
      const channelWarehouseId =
        order.type === 'PRIMARY' && order.distributorId
          ? await this.warehouses.ensureForDistributor(tx, order.distributorId, actorId)
          : null;

      for (const line of lines) {
        const quantity = line.quantity.toFixed(4);

        // 1. Draw down the reservation and ISSUE the stock. Refuses outright
        //    when nothing is reserved — invariant 2, enforced not asserted.
        await this.reservations.consumeQuantity(tx, {
          orderId: order.id,
          warehouseId: shipment.warehouseId,
          productId: line.orderLine.productId,
          variantId: line.orderLine.variantId,
          quantity,
          refType: 'SHIPMENT',
          refId: id,
          actorId,
        });

        // 2. Channel receipt, valued at what the PARTNER paid — their cost
        //    basis, not Hixaa's average (ADR-0014 §5). Using Hixaa's cost would
        //    understate channel value and make sell-through margin meaningless.
        if (channelWarehouseId) {
          await this.ledger.move(tx, {
            warehouseId: channelWarehouseId,
            productId: line.orderLine.productId,
            variantId: line.orderLine.variantId,
            movementType: 'RECEIPT',
            quantity,
            unitCost: line.orderLine.unitPrice.toFixed(4),
            refType: 'SHIPMENT',
            refId: id,
            occurredAt: dispatchedAt,
            actorId,
          });
        }

        // 3. Serial identity attaches now (ADR-0009).
        if (line.serials.length > 0) {
          await this.serials.recordDispatched(tx, {
            productId: line.orderLine.productId,
            serials: line.serials,
            distributorId: order.distributorId,
            batchId: null,
            dispatchedAt,
            actorId,
          });
        }

        // 4. The order line now knows it shipped.
        await tx.orderLine.update({
          where: { id: line.orderLine.id },
          data: {
            quantityDispatched: Money.of(line.orderLine.quantityDispatched.toFixed(4))
              .add(quantity)
              .toString(),
          },
        });
      }

      const result = await tx.shipment.update({
        where: { id },
        data: {
          status: 'DISPATCHED',
          dispatchedAt,
          carrierName: dto.carrierName ?? null,
          lrNumber: dto.lrNumber ?? null,
          vehicleNumber: dto.vehicleNumber ?? null,
          driverName: dto.driverName ?? null,
          driverPhone: dto.driverPhone ?? null,
          freightAmount: dto.freightAmount ?? null,
        },
        select: SHIPMENT_SELECT,
      });

      // 5. DISPATCHED or PARTIALLY_DISPATCHED, computed from the lines rather
      //    than set by hand — the two could otherwise disagree, and the header
      //    is the one people trust.
      const orderStatus = await this.orders.refreshFulfilmentStatus(tx, order.id);

      await this.orders.timelineEntry(tx, order.id, {
        event: 'DISPATCHED',
        description:
          `Shipment ${shipment.number} dispatched` +
          (dto.lrNumber ? ` on LR ${dto.lrNumber}` : '') +
          (channelWarehouseId ? ' — stock moved to the partner’s channel inventory' : ''),
        metadata: { shipmentId: id, orderStatus },
        actorId,
      });

      await this.audit.record(tx, {
        action: 'shipment.dispatched',
        entityType: 'Shipment',
        entityId: id,
        after: {
          number: shipment.number,
          orderNumber: order.number,
          lines: lines.length,
          orderStatus,
        },
        metadata: { actorId, lrNumber: dto.lrNumber },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.SHIPMENT_DISPATCHED,
        { type: 'Shipment', id },
        {
          number: shipment.number,
          orderNumber: order.number,
          lrNumber: dto.lrNumber ?? '',
          carrier: dto.carrierName ?? '',
        },
      );

      return result;
    });

    this.logger.info(
      { shipmentId: id, number: shipment.number, orderNumber: order.number },
      'Shipment dispatched',
    );
    return toSummary(updated);
  }

  async deliver(
    id: string,
    dto: { podDocumentId?: string; podReceivedBy?: string; deliveredAt?: string },
    actorId: string,
  ) {
    const shipment = await this.load(id);
    this.assertTransition(shipment.status, 'DELIVERED', shipment.number);

    const deliveredAt = dto.deliveredAt ? new Date(dto.deliveredAt) : this.clock.now();

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.shipment.update({
        where: { id },
        data: {
          status: 'DELIVERED',
          deliveredAt,
          podDocumentId: dto.podDocumentId ?? null,
          podReceivedBy: dto.podReceivedBy ?? null,
        },
        select: SHIPMENT_SELECT,
      });

      // An order whose every shipment has landed is DELIVERED. Computed from
      // the shipments, not set by whoever happened to click last.
      const siblings = await tx.shipment.findMany({
        where: { orderId: shipment.orderId, status: { notIn: ['RETURNED'] } },
        select: { status: true },
      });
      const allDelivered = siblings.every((sibling) => sibling.status === 'DELIVERED');

      if (allDelivered) {
        const order = await tx.order.findFirst({
          where: { id: shipment.orderId },
          select: { status: true },
        });
        // Only advance from DISPATCHED — a partially dispatched order still has
        // goods to send and is not delivered.
        if (order?.status === 'DISPATCHED') {
          await tx.order.update({
            where: { id: shipment.orderId },
            data: { status: 'DELIVERED' },
          });
        }
      }

      await this.orders.timelineEntry(tx, shipment.orderId, {
        event: 'DELIVERED',
        description:
          `Shipment ${shipment.number} delivered` +
          (dto.podReceivedBy ? `, received by ${dto.podReceivedBy}` : ''),
        actorId,
      });

      await this.audit.record(tx, {
        action: 'shipment.delivered',
        entityType: 'Shipment',
        entityId: id,
        after: { status: 'DELIVERED', podReceivedBy: dto.podReceivedBy ?? null },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.SHIPMENT_DELIVERED,
        { type: 'Shipment', id },
        { number: shipment.number, receivedBy: dto.podReceivedBy ?? '' },
      );

      return result;
    });

    return toSummary(updated);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async simpleTransition(
    id: string,
    to: ShipmentStatus,
    actorId: string,
    options: { action: string; data?: Prisma.ShipmentUpdateInput },
  ) {
    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.shipment.update({
        where: { id },
        data: { status: to, ...(options.data ?? {}) },
        select: SHIPMENT_SELECT,
      });

      await this.audit.record(tx, {
        action: options.action,
        entityType: 'Shipment',
        entityId: id,
        after: { status: to },
        metadata: { actorId },
      });

      return result;
    });

    return toSummary(updated);
  }

  private async load(id: string) {
    const shipment = await this.prisma.db.shipment.findFirst({
      where: { id },
      select: { id: true, number: true, status: true, orderId: true, warehouseId: true },
    });
    if (!shipment) throw new NotFoundError('Shipment', id);
    return shipment;
  }

  private async loadOrder(orderId: string) {
    const order = await this.prisma.db.order.findFirst({
      where: { id: orderId },
      select: {
        id: true,
        number: true,
        type: true,
        status: true,
        distributorId: true,
        warehouseId: true,
        lines: {
          select: {
            id: true,
            sku: true,
            quantity: true,
            quantityReserved: true,
            quantityBackordered: true,
            quantityDispatched: true,
            expectedAvailableDate: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundError('Order', orderId);
    return order;
  }

  private assertTransition(from: ShipmentStatus, to: ShipmentStatus, number: string): void {
    if (!canTransitionShipment(from, to)) {
      throw new ConflictError(
        `Shipment ${number} cannot move from ${from} to ${to}. ` +
          'Stock leaves the building exactly once.',
      );
    }
  }
}

function toSummary(row: ShipmentRow) {
  return {
    id: row.id,
    number: row.number,
    orderId: row.orderId,
    orderNumber: row.order.number,
    status: row.status,
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouse.code,
    carrierName: row.carrierName,
    lrNumber: row.lrNumber,
    vehicleNumber: row.vehicleNumber,
    lineCount: row.lines.length,
    totalQuantity: Money.sum(row.lines.map((line) => line.quantity.toFixed(4))).toString(),
    dispatchedAt: row.dispatchedAt,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
  };
}
