import { Injectable } from '@nestjs/common';
import {
  CANCELLABLE_ORDER_STATUSES,
  DOMAIN_EVENTS,
  Money,
  STOCK_COMMITTED_ORDER_STATUSES,
  canTransitionOrder,
  type ApproveOrderDto,
  type CreateOrderDto,
  type ListOrdersQuery,
  type OrderStatus,
  type UpdateOrderDto,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import {
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
} from '../../common/errors/domain.error';
import { keysetWhere, toListResult } from '../../common/utils/pagination.util';
import { AuditService } from '../../infrastructure/database/audit.service';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../infrastructure/database/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { NumberSequenceService } from '../distributors/number-sequence.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { OrderApprovalService } from './order-approval.service';
import { toLineData } from './quotations.service';
import { SalesPricingHelper } from './sales-pricing.helper';

/**
 * Orders — the commitment, and the phase's two invariants.
 *
 * ── What happens at APPROVED ───────────────────────────────────────────────
 * Approval is the moment a proposal becomes a promise, so three things happen
 * there and nowhere else:
 *
 *   1. **Credit** is checked, and a breach is refused unless a Finance Manager
 *      overrides with a stated reason (docs/00 §4.2 invariant 1).
 *   2. **Ceilings** are checked, and self-approval is refused outright.
 *   3. **Stock is reserved per line** — as much as exists, with the shortfall
 *      recorded as backordered (ADR-0012).
 *
 * After that the figures are frozen (ADR-0011). Amending an approved order is
 * a cancel-and-reraise, not an edit.
 */
const ORDER_SELECT = {
  id: true,
  number: true,
  type: true,
  status: true,
  distributorId: true,
  customerId: true,
  quotationId: true,
  warehouseId: true,
  orderDate: true,
  expectedDate: true,
  customerPoNumber: true,
  creditOverridden: true,
  creditOverrideReason: true,
  subtotal: true,
  totalDiscount: true,
  taxableValue: true,
  totalCgst: true,
  totalSgst: true,
  totalIgst: true,
  totalTax: true,
  roundOff: true,
  grandTotal: true,
  approvedAt: true,
  approvedById: true,
  createdAt: true,
  createdById: true,
  distributor: { select: { legalName: true } },
  customer: { select: { name: true } },
  _count: { select: { lines: true } },
} satisfies Prisma.OrderSelect;

type OrderRow = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingHelper: SalesPricingHelper,
    private readonly approvals: OrderApprovalService,
    private readonly ledger: StockLedgerService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly sequences: NumberSequenceService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OrdersService.name);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(query: ListOrdersQuery) {
    const where: Prisma.OrderWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.distributorId ? { distributorId: query.distributorId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.q ? { number: { contains: query.q.toUpperCase() } } : {}),
      ...(query.hasBackorder ? { lines: { some: { quantityBackordered: { gt: 0 } } } } : {}),
    };

    if (query.status) {
      where.status = Array.isArray(query.status) ? { in: query.status } : query.status;
    }
    if (query.from || query.to) {
      where.orderDate = {
        ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
        ...(query.to ? { lte: new Date(`${query.to}T00:00:00.000Z`) } : {}),
      };
    }

    const cursorWhere = keysetWhere(query.cursor);
    const rows = await this.prisma.db.order.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: ORDER_SELECT,
    });

    const totalCount = query.includeTotal
      ? await this.prisma.db.order.count({ where })
      : undefined;

    // Fulfilment flags come from the lines, fetched once rather than per row.
    const aggregates = await this.fulfilmentFlags(rows.map((row) => row.id));

    const result = toListResult(rows, query.limit, totalCount);
    return {
      ...result,
      data: result.data.map((row) => this.toSummary(row, aggregates.get(row.id))),
    };
  }

  async findDetail(id: string) {
    const order = await this.prisma.db.order.findFirst({
      where: { id },
      select: ORDER_SELECT,
    });
    if (!order) throw new NotFoundError('Order', id);

    const [lines, approvals, shipments, timeline] = await Promise.all([
      this.prisma.db.orderLine.findMany({
        where: { orderId: id },
        orderBy: { lineNumber: 'asc' },
        select: ORDER_LINE_SELECT,
      }),
      this.prisma.db.orderApproval.findMany({
        where: { orderId: id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          kind: true,
          requestedValue: true,
          approverCeiling: true,
          approvedById: true,
          reason: true,
          createdAt: true,
        },
      }),
      this.prisma.db.shipment.findMany({
        where: { orderId: id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          number: true,
          status: true,
          lrNumber: true,
          dispatchedAt: true,
          deliveredAt: true,
        },
      }),
      this.prisma.db.orderTimeline.findMany({
        where: { orderId: id },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          event: true,
          description: true,
          metadata: true,
          actorId: true,
          createdAt: true,
        },
      }),
    ]);

    const aggregates = await this.fulfilmentFlags([id]);

    return {
      ...this.toSummary(order, aggregates.get(id)),
      lines: lines.map(toOrderLineSummary),
      approvals: approvals.map((approval) => ({
        ...approval,
        requestedValue: approval.requestedValue.toFixed(4),
        approverCeiling: approval.approverCeiling ? approval.approverCeiling.toFixed(4) : null,
      })),
      shipments,
      timeline,
    };
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async create(dto: CreateOrderDto, actorId: string) {
    const context = await this.resolveContext(dto);
    const orderDate = dto.orderDate ?? this.toDateOnly(this.clock.now());

    const priced = await this.pricingHelper.priceLines({
      lines: dto.lines,
      // A SECONDARY order is the distributor's own sale; Hixaa's price list is
      // only a default, and the recorder overrides with what was charged
      // (ADR-0014 §6). The distributor is still passed so authorized-catalog
      // and place-of-supply resolution behave the same way.
      distributorId: dto.distributorId ?? null,
      priceListId: dto.priceListId ?? null,
      placeOfSupplyStateCode: dto.placeOfSupplyStateCode ?? context.stateCode,
      asOf: orderDate,
      actorId,
    });

    const created = await this.prisma.transaction(async (tx) => {
      const number = await this.sequences.next(tx, 'ORDER');

      const order = await tx.order.create({
        data: {
          number,
          type: dto.type,
          status: 'DRAFT',
          distributorId: dto.distributorId ?? null,
          customerId: dto.customerId ?? null,
          quotationId: dto.quotationId ?? null,
          warehouseId: context.warehouseId,
          placeOfSupplyStateCode: dto.placeOfSupplyStateCode ?? context.stateCode,
          priceListId: dto.priceListId ?? null,
          orderDate: new Date(`${orderDate}T00:00:00.000Z`),
          expectedDate: dto.expectedDate
            ? new Date(`${dto.expectedDate}T00:00:00.000Z`)
            : null,
          customerPoNumber: dto.customerPoNumber ?? null,
          customerPoDate: dto.customerPoDate
            ? new Date(`${dto.customerPoDate}T00:00:00.000Z`)
            : null,
          paymentTermsCode: dto.paymentTermsCode ?? context.paymentTermsCode,
          notes: dto.notes ?? null,
          createdById: actorId,
          ...priced.totals,
          lines: { createMany: { data: priced.lines.map(toLineData) } },
        },
        select: ORDER_SELECT,
      });

      await this.timelineEntry(tx, order.id, {
        event: 'CREATED',
        description: `Order ${number} created with ${dto.lines.length} line(s)`,
        actorId,
      });

      await this.audit.record(tx, {
        action: 'order.created',
        entityType: 'Order',
        entityId: order.id,
        after: { number, type: dto.type, grandTotal: priced.totals.grandTotal },
      });

      return order;
    });

    this.logger.info({ orderId: created.id, number: created.number }, 'Order created');
    return this.toSummary(created, undefined);
  }

  /** Converts an ACCEPTED quotation into a DRAFT order, re-pricing as it goes. */
  async createFromQuotation(
    quotationId: string,
    overrides: Partial<CreateOrderDto>,
    actorId: string,
  ) {
    const quotation = await this.prisma.db.quotation.findFirst({
      where: { id: quotationId },
      select: {
        id: true,
        number: true,
        status: true,
        distributorId: true,
        customerId: true,
        priceListId: true,
        placeOfSupplyStateCode: true,
        lines: {
          orderBy: { lineNumber: 'asc' },
          select: { productId: true, variantId: true, quantity: true, notes: true },
        },
      },
    });
    if (!quotation) throw new NotFoundError('Quotation', quotationId);

    if (quotation.status !== 'ACCEPTED') {
      throw new ConflictError(
        `Quotation ${quotation.number} is ${quotation.status}. Only an ACCEPTED quotation can ` +
          'become an order — converting a draft would commit terms nobody agreed to.',
      );
    }

    const dto: CreateOrderDto = {
      type: overrides.type ?? (quotation.distributorId ? 'PRIMARY' : 'SECONDARY'),
      ...(quotation.distributorId ? { distributorId: quotation.distributorId } : {}),
      ...(quotation.customerId ? { customerId: quotation.customerId } : {}),
      quotationId,
      ...(quotation.priceListId ? { priceListId: quotation.priceListId } : {}),
      ...(quotation.placeOfSupplyStateCode
        ? { placeOfSupplyStateCode: quotation.placeOfSupplyStateCode }
        : {}),
      ...(overrides.warehouseId ? { warehouseId: overrides.warehouseId } : {}),
      ...(overrides.customerPoNumber ? { customerPoNumber: overrides.customerPoNumber } : {}),
      lines: quotation.lines.map((line) => ({
        productId: line.productId,
        ...(line.variantId ? { variantId: line.variantId } : {}),
        quantity: line.quantity.toFixed(4),
        ...(line.notes ? { notes: line.notes } : {}),
      })),
    } as CreateOrderDto;

    const order = await this.create(dto, actorId);

    await this.prisma.transaction(async (tx) => {
      await tx.quotation.update({ where: { id: quotationId }, data: { status: 'CONVERTED' } });
      await this.timelineEntry(tx, order.id, {
        event: 'CONVERTED_FROM_QUOTATION',
        description: `Converted from quotation ${quotation.number}`,
        actorId,
      });
    });

    return order;
  }

  async update(id: string, dto: UpdateOrderDto, actorId: string) {
    const order = await this.load(id);

    // ADR-0011: once approved the figures are frozen. Amending is a
    // cancel-and-reraise, which leaves a record of what changed and why.
    if (order.status !== 'DRAFT') {
      throw new ConflictError(
        `Order ${order.number} is ${order.status} and can no longer be edited. ` +
          'Cancel it and raise a new one — an approved order is a commitment.',
      );
    }

    const priced = dto.lines
      ? await this.pricingHelper.priceLines({
          lines: dto.lines,
          distributorId: order.distributorId,
          priceListId: order.priceListId,
          placeOfSupplyStateCode: order.placeOfSupplyStateCode,
          asOf: this.toDateOnly(order.orderDate),
          actorId,
        })
      : null;

    const updated = await this.prisma.transaction(async (tx) => {
      if (priced) {
        await tx.orderLine.deleteMany({ where: { orderId: id } });
        await tx.orderLine.createMany({
          data: priced.lines.map((line) => ({ ...toLineData(line), orderId: id })),
        });
      }

      const result = await tx.order.update({
        where: { id },
        data: {
          ...(dto.expectedDate !== undefined
            ? {
                expectedDate: dto.expectedDate
                  ? new Date(`${dto.expectedDate}T00:00:00.000Z`)
                  : null,
              }
            : {}),
          ...(dto.customerPoNumber !== undefined
            ? { customerPoNumber: dto.customerPoNumber }
            : {}),
          ...(dto.paymentTermsCode !== undefined
            ? { paymentTermsCode: dto.paymentTermsCode }
            : {}),
          ...(dto.warehouseId !== undefined ? { warehouseId: dto.warehouseId } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(priced ? priced.totals : {}),
        },
        select: ORDER_SELECT,
      });

      await this.audit.record(tx, {
        action: 'order.updated',
        entityType: 'Order',
        entityId: id,
        after: priced ? { grandTotal: priced.totals.grandTotal } : {},
        metadata: { actorId },
      });

      return result;
    });

    return this.toSummary(updated, undefined);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * DRAFT → PENDING_APPROVAL.
   *
   * The gate that stops an order reaching approval in a state that cannot be
   * fulfilled: the partner must be able to transact, and every product must be
   * one they are authorized to buy.
   */
  async submit(id: string, actorId: string) {
    const order = await this.load(id);
    this.assertTransition(order.status, 'PENDING_APPROVAL', order.number);

    if (order.lineCount === 0) {
      throw new ConflictError(`Order ${order.number} has no lines.`);
    }

    if (order.type === 'PRIMARY' && order.distributorId) {
      const distributor = await this.prisma.db.distributor.findFirst({
        where: { id: order.distributorId },
        select: { id: true, code: true, status: true },
      });
      if (!distributor) throw new NotFoundError('Distributor', order.distributorId);

      // Phase 5 established that only ACTIVE partners may transact.
      if (distributor.status !== 'ACTIVE') {
        throw new ConflictError(
          `${distributor.code} is ${distributor.status} and cannot place orders. ` +
            'Only an ACTIVE distributor may transact.',
        );
      }
    }

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.order.update({
        where: { id },
        data: { status: 'PENDING_APPROVAL', submittedAt: this.clock.now() },
        select: ORDER_SELECT,
      });

      await this.timelineEntry(tx, id, {
        event: 'SUBMITTED',
        description: 'Submitted for approval',
        actorId,
      });

      await this.audit.record(tx, {
        action: 'order.submitted',
        entityType: 'Order',
        entityId: id,
        after: { status: 'PENDING_APPROVAL' },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.ORDER_SUBMITTED,
        { type: 'Order', id },
        { number: order.number, grandTotal: order.grandTotal.toFixed(4) },
      );

      return result;
    });

    return this.toSummary(updated, undefined);
  }

  /**
   * PENDING_APPROVAL → APPROVED. The phase's central operation.
   *
   * Runs the credit gate, the ceiling gate, and then reserves stock per line —
   * all in one transaction, so an order can never end up approved with its
   * stock uncommitted, nor stock committed to an order that failed to approve.
   */
  async approve(id: string, dto: ApproveOrderDto, actorId: string) {
    const order = await this.load(id);
    this.assertTransition(order.status, 'APPROVED', order.number);

    const lines = await this.prisma.db.orderLine.findMany({
      where: { orderId: id },
      orderBy: { lineNumber: 'asc' },
      select: {
        id: true,
        productId: true,
        variantId: true,
        sku: true,
        quantity: true,
        discountPercent: true,
        product: { select: { leadTimeDays: true } },
      },
    });

    // The WORST line, not the average — averaging would let a 40% giveaway on
    // one item hide behind full-price lines, which is the case a ceiling exists
    // to catch.
    const maxDiscount = lines.reduce(
      (worst, line) => Money.max(worst, Money.of(line.discountPercent.toFixed(4))),
      Money.zero(),
    );

    // ── Gate 1: ceilings and self-approval ────────────────────────────────
    const decision = await this.approvals.assertMayApprove({
      approverId: actorId,
      createdById: order.createdById,
      maxLineDiscountPercent: maxDiscount.toString(),
      orderValue: order.grandTotal.toFixed(4),
    });

    // ── Gate 2: credit. Sell-out skips it — the distributor already paid ──
    let creditOverridden = false;
    let creditCheck = null;
    if (order.type === 'PRIMARY' && order.distributorId) {
      creditCheck = await this.approvals.checkCredit({
        distributorId: order.distributorId,
        orderValue: order.grandTotal.toFixed(4),
        excludeOrderId: id,
      });

      const outcome = await this.approvals.assertCreditOrOverride({
        check: creditCheck,
        ...(dto.creditOverrideReason ? { overrideReason: dto.creditOverrideReason } : {}),
        approverId: actorId,
      });
      creditOverridden = outcome.overridden;
    }

    const warehouseId = order.warehouseId ?? (await this.defaultWarehouseId());
    if (!warehouseId) {
      throw new ConflictError(
        'No warehouse is configured to fulfil this order. Set a default warehouse first.',
      );
    }

    const approvedAt = this.clock.now();

    const updated = await this.prisma.transaction(async (tx) => {
      // ── Gate 3: reserve what exists, backorder the rest (ADR-0012) ──────
      let anyBackorder = false;

      for (const line of lines) {
        const outcome = await this.ledger.reserveUpTo(tx, {
          warehouseId,
          productId: line.productId,
          variantId: line.variantId,
          requested: line.quantity.toFixed(4),
        });

        const backordered = Money.of(outcome.backordered);
        if (backordered.isPositive()) anyBackorder = true;

        // A reservation row exists only when something was actually held.
        if (Money.of(outcome.reserved).isPositive()) {
          await tx.stockReservation.create({
            data: {
              warehouseId,
              productId: line.productId,
              variantId: line.variantId,
              orderId: id,
              quantity: outcome.reserved,
              status: 'ACTIVE',
              // Deliberately no expiry: a build-to-order line may wait months,
              // and the Phase 6 sweep must not release it (ADR-0012).
              createdById: actorId,
            },
          });
        }

        await tx.orderLine.update({
          where: { id: line.id },
          data: {
            quantityReserved: outcome.reserved,
            quantityBackordered: outcome.backordered,
            expectedAvailableDate: backordered.isPositive()
              ? this.leadTimeDate(approvedAt, line.product.leadTimeDays)
              : null,
          },
        });
      }

      const result = await tx.order.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedAt,
          approvedById: actorId,
          creditOverridden,
          creditOverrideReason: creditOverridden ? (dto.creditOverrideReason ?? null) : null,
        },
        select: ORDER_SELECT,
      });

      // ── Record what authority was exercised ─────────────────────────────
      if (maxDiscount.isPositive()) {
        await tx.orderApproval.create({
          data: {
            orderId: id,
            kind: 'DISCOUNT',
            requestedValue: decision.exercisedDiscount,
            approverCeiling: decision.approverCeilingDiscount,
            approvedById: actorId,
            reason: dto.approvalReason ?? null,
          },
        });
      }

      await tx.orderApproval.create({
        data: {
          orderId: id,
          kind: 'ORDER_VALUE',
          requestedValue: decision.exercisedValue,
          approverCeiling: decision.approverCeilingValue,
          approvedById: actorId,
          reason: dto.approvalReason ?? null,
        },
      });

      if (creditOverridden && creditCheck) {
        await tx.orderApproval.create({
          data: {
            orderId: id,
            kind: 'CREDIT_LIMIT',
            requestedValue: creditCheck.orderValue,
            approverCeiling: creditCheck.creditLimit,
            approvedById: actorId,
            reason: dto.creditOverrideReason ?? null,
          },
        });

        // A credit override is a SECURITY event: it is the one place the
        // company knowingly takes unsecured exposure.
        await this.audit.record(tx, {
          category: 'SECURITY',
          action: 'order.credit_limit_overridden',
          entityType: 'Order',
          entityId: id,
          before: {
            creditLimit: creditCheck.creditLimit,
            exposure: creditCheck.currentExposure,
          },
          after: { orderValue: creditCheck.orderValue, headroom: creditCheck.headroom },
          metadata: { reason: dto.creditOverrideReason, approverId: actorId },
        });

        await this.outbox.emit(
          tx,
          DOMAIN_EVENTS.DISTRIBUTOR_CREDIT_LIMIT_CHANGED,
          { type: 'Order', id },
          {
            number: order.number,
            distributor: creditCheck.distributorCode,
            limit: creditCheck.creditLimit,
            exposure: creditCheck.currentExposure,
            reason: dto.creditOverrideReason ?? '',
          },
        );
      }

      await this.timelineEntry(tx, id, {
        event: 'APPROVED',
        description: anyBackorder
          ? 'Approved — some lines are backordered and cannot ship yet'
          : 'Approved and fully reserved',
        metadata: {
          creditOverridden,
          maxDiscountPercent: maxDiscount.toString(),
        },
        actorId,
      });

      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'order.approved',
        entityType: 'Order',
        entityId: id,
        before: { status: order.status },
        after: {
          status: 'APPROVED',
          grandTotal: order.grandTotal.toFixed(4),
          creditOverridden,
        },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.ORDER_APPROVED,
        { type: 'Order', id },
        { number: order.number, grandTotal: order.grandTotal.toFixed(4) },
      );

      return result;
    });

    this.logger.info(
      { orderId: id, number: order.number, approverId: actorId, creditOverridden },
      'Order approved',
    );

    const aggregates = await this.fulfilmentFlags([id]);
    return { ...this.toSummary(updated, aggregates.get(id)), creditCheck };
  }

  async reject(id: string, reason: string, actorId: string) {
    const order = await this.load(id);
    this.assertTransition(order.status, 'REJECTED', order.number);

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.order.update({
        where: { id },
        data: { status: 'REJECTED', statusReason: reason },
        select: ORDER_SELECT,
      });

      await this.timelineEntry(tx, id, {
        event: 'REJECTED',
        description: reason,
        actorId,
      });

      await this.audit.record(tx, {
        action: 'order.rejected',
        entityType: 'Order',
        entityId: id,
        after: { status: 'REJECTED' },
        metadata: { reason, actorId },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.ORDER_REJECTED,
        { type: 'Order', id },
        { number: order.number, reason },
      );

      return result;
    });

    return this.toSummary(updated, undefined);
  }

  /**
   * Cancels an order and RELEASES every reservation it holds.
   *
   * The release is the point. Stock held against a dead order is stock the
   * business cannot sell, and the failure would be invisible — availability
   * quietly lower than it should be, with nothing pointing at the cause.
   */
  async cancel(id: string, reason: string, actorId: string) {
    const order = await this.load(id);

    if (!CANCELLABLE_ORDER_STATUSES.includes(order.status)) {
      throw new ConflictError(
        `Order ${order.number} is ${order.status} and can no longer be cancelled — ` +
          'goods have already moved. Raise a return instead.',
      );
    }
    this.assertTransition(order.status, 'CANCELLED', order.number);

    const releasesNeeded = STOCK_COMMITTED_ORDER_STATUSES.includes(order.status);

    const updated = await this.prisma.transaction(async (tx) => {
      let released = 0;

      if (releasesNeeded) {
        const reservations = await tx.stockReservation.findMany({
          where: { orderId: id, status: 'ACTIVE' },
          select: { id: true, warehouseId: true, productId: true, variantId: true, quantity: true },
        });

        for (const reservation of reservations) {
          await this.ledger.adjustReserved(tx, {
            warehouseId: reservation.warehouseId,
            productId: reservation.productId,
            variantId: reservation.variantId,
            delta: Money.of(reservation.quantity.toFixed(4)).negate().toString(),
          });
          await tx.stockReservation.update({
            where: { id: reservation.id },
            data: { status: 'RELEASED', releasedAt: this.clock.now() },
          });
          released++;
        }

        await tx.orderLine.updateMany({
          where: { orderId: id },
          data: { quantityReserved: 0, quantityBackordered: 0 },
        });
      }

      const result = await tx.order.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: this.clock.now(), statusReason: reason },
        select: ORDER_SELECT,
      });

      await this.timelineEntry(tx, id, {
        event: 'CANCELLED',
        description: reason,
        metadata: { reservationsReleased: released },
        actorId,
      });

      await this.audit.record(tx, {
        action: 'order.cancelled',
        entityType: 'Order',
        entityId: id,
        before: { status: order.status },
        after: { status: 'CANCELLED', reservationsReleased: released },
        metadata: { reason, actorId },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.ORDER_CANCELLED,
        { type: 'Order', id },
        { number: order.number, reason },
      );

      return result;
    });

    this.logger.info({ orderId: id, number: order.number, reason }, 'Order cancelled');
    return this.toSummary(updated, undefined);
  }

  /**
   * Re-attempts reservation for backordered lines.
   *
   * Explicit rather than automatic on goods receipt (ADR-0012 §4): allocating
   * scarce stock between waiting customers is a commercial judgement, and one
   * that should be made by a person who can be asked why.
   */
  async reserveOutstanding(id: string, actorId: string) {
    const order = await this.load(id);

    if (!STOCK_COMMITTED_ORDER_STATUSES.includes(order.status)) {
      throw new ConflictError(
        `Order ${order.number} is ${order.status}; only an approved order holds stock.`,
      );
    }

    const warehouseId = order.warehouseId ?? (await this.defaultWarehouseId());
    if (!warehouseId) throw new ConflictError('No warehouse is configured for this order.');

    const lines = await this.prisma.db.orderLine.findMany({
      where: { orderId: id, quantityBackordered: { gt: 0 } },
      select: {
        id: true,
        productId: true,
        variantId: true,
        sku: true,
        quantityReserved: true,
        quantityBackordered: true,
      },
    });

    if (lines.length === 0) {
      return { filled: 0, stillBackordered: 0, lines: [] };
    }

    const outcomes = await this.prisma.transaction(async (tx) => {
      const results = [];

      for (const line of lines) {
        const outcome = await this.ledger.reserveUpTo(tx, {
          warehouseId,
          productId: line.productId,
          variantId: line.variantId,
          requested: line.quantityBackordered.toFixed(4),
        });

        const newlyReserved = Money.of(outcome.reserved);
        if (newlyReserved.isPositive()) {
          await tx.stockReservation.create({
            data: {
              warehouseId,
              productId: line.productId,
              variantId: line.variantId,
              orderId: id,
              quantity: outcome.reserved,
              status: 'ACTIVE',
              createdById: actorId,
            },
          });

          await tx.orderLine.update({
            where: { id: line.id },
            data: {
              quantityReserved: Money.of(line.quantityReserved.toFixed(4))
                .add(newlyReserved)
                .toString(),
              quantityBackordered: outcome.backordered,
            },
          });
        }

        results.push({
          sku: line.sku,
          newlyReserved: outcome.reserved,
          stillBackordered: outcome.backordered,
        });
      }

      await this.timelineEntry(tx, id, {
        event: 'BACKORDER_FILLED',
        description: `Re-attempted reservation on ${lines.length} backordered line(s)`,
        actorId,
      });

      return results;
    });

    return {
      filled: outcomes.filter((o) => Money.of(o.newlyReserved).isPositive()).length,
      stillBackordered: outcomes.filter((o) => Money.of(o.stillBackordered).isPositive()).length,
      lines: outcomes,
    };
  }

  /** Read by ShipmentsService when dispatch changes fulfilment state. */
  async refreshFulfilmentStatus(tx: PrismaTransaction, orderId: string): Promise<OrderStatus> {
    const lines = await tx.orderLine.findMany({
      where: { orderId },
      select: { quantity: true, quantityDispatched: true },
    });

    const ordered = Money.sum(lines.map((line) => line.quantity.toFixed(4)));
    const dispatched = Money.sum(lines.map((line) => line.quantityDispatched.toFixed(4)));

    // Computed from the lines, never set by hand — the two could otherwise
    // disagree and the header would be the one people trust.
    const next: OrderStatus = dispatched.isZero()
      ? 'PROCESSING'
      : dispatched.gte(ordered)
        ? 'DISPATCHED'
        : 'PARTIALLY_DISPATCHED';

    await tx.order.update({ where: { id: orderId }, data: { status: next } });
    return next;
  }

  async timeline(id: string) {
    await this.load(id);
    const entries = await this.prisma.db.orderTimeline.findMany({
      where: { orderId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        event: true,
        description: true,
        metadata: true,
        actorId: true,
        createdAt: true,
      },
    });
    return { data: entries };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  async timelineEntry(
    tx: PrismaTransaction,
    orderId: string,
    entry: {
      event: string;
      description: string;
      metadata?: Record<string, unknown>;
      actorId: string | null;
    },
  ): Promise<void> {
    await tx.orderTimeline.create({
      data: {
        orderId,
        event: entry.event,
        description: entry.description,
        metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        actorId: entry.actorId,
      },
    });
  }

  private async load(id: string) {
    const order = await this.prisma.db.order.findFirst({
      where: { id },
      select: {
        id: true,
        number: true,
        type: true,
        status: true,
        distributorId: true,
        customerId: true,
        warehouseId: true,
        priceListId: true,
        placeOfSupplyStateCode: true,
        orderDate: true,
        grandTotal: true,
        createdById: true,
        _count: { select: { lines: true } },
      },
    });
    if (!order) throw new NotFoundError('Order', id);
    return { ...order, lineCount: order._count.lines };
  }

  private assertTransition(from: OrderStatus, to: OrderStatus, number: string): void {
    if (!canTransitionOrder(from, to)) {
      throw new InvalidStateTransitionError(`order ${number}`, from, to);
    }
  }

  /**
   * Resolves the counterparty, its state code, and which warehouse fulfils.
   *
   * For a SECONDARY order the fulfilling warehouse is the DISTRIBUTOR's, not
   * Hixaa's — sell-out decrements the partner's stock (ADR-0014 §3).
   */
  private async resolveContext(dto: CreateOrderDto) {
    let stateCode: string | null = null;
    let paymentTermsCode: string | null = null;
    let warehouseId: string | null = dto.warehouseId ?? null;

    if (dto.distributorId) {
      const distributor = await this.prisma.db.distributor.findFirst({
        where: { id: dto.distributorId },
        select: { id: true, gstin: true, paymentTermsCode: true },
      });
      if (!distributor) throw new NotFoundError('Distributor', dto.distributorId);
      stateCode = distributor.gstin ? distributor.gstin.slice(0, 2) : null;
      paymentTermsCode = distributor.paymentTermsCode;
    }

    if (dto.customerId) {
      const customer = await this.prisma.db.customer.findFirst({
        where: { id: dto.customerId },
        select: { id: true, gstin: true, distributorId: true },
      });
      if (!customer) throw new NotFoundError('Customer', dto.customerId);
      // A customer's own state wins for place of supply — the goods go to them.
      stateCode = customer.gstin ? customer.gstin.slice(0, 2) : stateCode;

      if (dto.type === 'SECONDARY' && !warehouseId) {
        const sellingDistributorId = dto.distributorId ?? customer.distributorId;
        if (!sellingDistributorId) {
          throw new ConflictError(
            'A sell-out must name the distributor making the sale, or the customer must be ' +
              'assigned to one — the stock comes out of that partner’s warehouse.',
          );
        }
        const partnerWarehouse = await this.prisma.db.warehouse.findFirst({
          where: { distributorId: sellingDistributorId, type: 'DISTRIBUTOR' },
          select: { id: true },
        });
        if (!partnerWarehouse) {
          throw new ConflictError(
            'That distributor holds no stock yet — nothing has been dispatched to them, so ' +
              'there is nothing to sell on. Dispatch a sell-in order first.',
          );
        }
        warehouseId = partnerWarehouse.id;
      }
    }

    if (!warehouseId && dto.type === 'PRIMARY') {
      warehouseId = await this.defaultWarehouseId();
    }

    return { stateCode, paymentTermsCode, warehouseId };
  }

  private async defaultWarehouseId(): Promise<string | null> {
    const warehouse = await this.prisma.db.warehouse.findFirst({
      where: { isDefault: true, isActive: true },
      select: { id: true },
    });
    return warehouse?.id ?? null;
  }

  /** An estimate from the product's lead time, and labelled as one in the UI. */
  private leadTimeDate(from: Date, leadTimeDays: number | null): Date | null {
    if (!leadTimeDays) return null;
    return new Date(from.getTime() + leadTimeDays * 86_400_000);
  }

  /** Fulfilment flags for a set of orders, in one query rather than N. */
  private async fulfilmentFlags(orderIds: readonly string[]) {
    if (orderIds.length === 0) return new Map<string, FulfilmentFlags>();

    const lines = await this.prisma.db.orderLine.findMany({
      where: { orderId: { in: [...orderIds] } },
      select: { orderId: true, quantity: true, quantityBackordered: true, quantityDispatched: true },
    });

    const byOrder = new Map<string, FulfilmentFlags>();
    for (const line of lines) {
      const current = byOrder.get(line.orderId) ?? { hasBackorder: false, fullyDispatched: true };
      if (line.quantityBackordered.greaterThan(0)) current.hasBackorder = true;
      if (line.quantityDispatched.lessThan(line.quantity)) current.fullyDispatched = false;
      byOrder.set(line.orderId, current);
    }
    return byOrder;
  }

  private toSummary(row: OrderRow, flags: FulfilmentFlags | undefined) {
    return {
      id: row.id,
      number: row.number,
      type: row.type,
      status: row.status,
      distributorId: row.distributorId,
      distributorName: row.distributor?.legalName ?? null,
      customerId: row.customerId,
      customerName: row.customer?.name ?? null,
      quotationId: row.quotationId,
      warehouseId: row.warehouseId,
      orderDate: this.toDateOnly(row.orderDate),
      expectedDate: row.expectedDate ? this.toDateOnly(row.expectedDate) : null,
      customerPoNumber: row.customerPoNumber,
      creditOverridden: row.creditOverridden,
      creditOverrideReason: row.creditOverrideReason,
      subtotal: row.subtotal.toFixed(4),
      totalDiscount: row.totalDiscount.toFixed(4),
      taxableValue: row.taxableValue.toFixed(4),
      totalCgst: row.totalCgst.toFixed(4),
      totalSgst: row.totalSgst.toFixed(4),
      totalIgst: row.totalIgst.toFixed(4),
      totalTax: row.totalTax.toFixed(4),
      roundOff: row.roundOff.toFixed(4),
      grandTotal: row.grandTotal.toFixed(4),
      lineCount: row._count.lines,
      hasBackorder: flags?.hasBackorder ?? false,
      fullyDispatched: flags?.fullyDispatched ?? false,
      approvedAt: row.approvedAt,
      approvedById: row.approvedById,
      createdAt: row.createdAt,
    };
  }

  private toDateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}

interface FulfilmentFlags {
  hasBackorder: boolean;
  fullyDispatched: boolean;
}

const ORDER_LINE_SELECT = {
  id: true,
  lineNumber: true,
  productId: true,
  variantId: true,
  sku: true,
  description: true,
  quantity: true,
  uomCode: true,
  quantityReserved: true,
  quantityBackordered: true,
  quantityDispatched: true,
  expectedAvailableDate: true,
  unitListPrice: true,
  unitPrice: true,
  discountAmount: true,
  discountPercent: true,
  overrideReason: true,
  taxableValue: true,
  hsnSacCode: true,
  gstRate: true,
  cgst: true,
  sgst: true,
  igst: true,
  totalTax: true,
  lineTotal: true,
} satisfies Prisma.OrderLineSelect;

type OrderLineRow = Prisma.OrderLineGetPayload<{ select: typeof ORDER_LINE_SELECT }>;

function toOrderLineSummary(row: OrderLineRow) {
  const quantity = Money.of(row.quantity.toFixed(4));
  const dispatched = Money.of(row.quantityDispatched.toFixed(4));

  return {
    id: row.id,
    lineNumber: row.lineNumber,
    productId: row.productId,
    variantId: row.variantId,
    sku: row.sku,
    description: row.description,
    quantity: quantity.toString(),
    uomCode: row.uomCode,
    quantityReserved: row.quantityReserved.toFixed(4),
    quantityBackordered: row.quantityBackordered.toFixed(4),
    quantityDispatched: dispatched.toString(),
    quantityOutstanding: quantity.subtract(dispatched).toString(),
    expectedAvailableDate: row.expectedAvailableDate
      ? row.expectedAvailableDate.toISOString().slice(0, 10)
      : null,
    isBackordered: row.quantityBackordered.greaterThan(0),
    unitListPrice: row.unitListPrice.toFixed(4),
    unitPrice: row.unitPrice.toFixed(4),
    discountAmount: row.discountAmount.toFixed(4),
    discountPercent: row.discountPercent.toFixed(4),
    overrideReason: row.overrideReason,
    taxableValue: row.taxableValue.toFixed(4),
    hsnSacCode: row.hsnSacCode,
    gstRate: row.gstRate.toFixed(2),
    cgst: row.cgst.toFixed(4),
    sgst: row.sgst.toFixed(4),
    igst: row.igst.toFixed(4),
    totalTax: row.totalTax.toFixed(4),
    lineTotal: row.lineTotal.toFixed(4),
  };
}

export { toOrderLineSummary, ORDER_LINE_SELECT };
