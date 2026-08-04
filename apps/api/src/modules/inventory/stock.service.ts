import { Injectable } from '@nestjs/common';
import {
  DOMAIN_EVENTS,
  Money,
  canTransitionTransfer,
  type CreateTransferDto,
  type GoodsReceiptDto,
  type ListBalancesQuery,
  type ListLedgerQuery,
  type OpeningBalanceDto,
  type StockAdjustmentDto,
  type StockIssueDto,
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
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { NumberSequenceService } from '../distributors/number-sequence.service';
import { stockValue } from './costing';
import { SerialsService } from './serials.service';
import { StockLedgerService } from './stock-ledger.service';

/**
 * Stock movements: receipts, issues, adjustments, opening balances, transfers.
 *
 * Every one of them funnels through `StockLedgerService.move()`. Nothing here
 * touches `stock_ledger_entry` or `stock_balance` directly — that is the rule
 * that keeps the row lock impossible to forget (docs/19 §3).
 *
 * All the multi-line operations run in ONE transaction: a receipt of three
 * products lands entirely or not at all. A half-applied stock movement is worse
 * than a rejected one, because nothing says it is half-applied.
 */
@Injectable()
export class StockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: StockLedgerService,
    private readonly serials: SerialsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly sequences: NumberSequenceService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(StockService.name);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async listBalances(query: ListBalancesQuery) {
    const where: Prisma.StockBalanceWhereInput = {
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.inStockOnly ? { quantityOnHand: { gt: 0 } } : {}),
    };

    const rows = await this.prisma.db.stockBalance.findMany({
      where,
      orderBy: [{ product: { sku: 'asc' } }],
      take: query.limit + 1,
      select: BALANCE_SELECT,
    });

    // Reorder levels are a separate table, fetched once rather than joined per
    // row, so the "below reorder level" flag costs one query not N.
    const settings = await this.prisma.db.inventorySetting.findMany({
      where: {
        productId: { in: rows.map((row) => row.productId) },
        warehouseId: { in: rows.map((row) => row.warehouseId) },
      },
      select: { productId: true, warehouseId: true, reorderLevel: true },
    });
    const levels = new Map(
      settings.map((s) => [`${s.warehouseId}:${s.productId}`, s.reorderLevel.toFixed(4)]),
    );

    let data = rows.slice(0, query.limit).map((row) => toBalanceSummary(row, levels));
    if (query.belowReorderLevel) data = data.filter((row) => row.isBelowReorderLevel);

    return {
      data,
      meta: { cursor: { next: null, hasMore: rows.length > query.limit }, totalCount: data.length },
    };
  }

  /** Stock for one product across every warehouse the caller can see. */
  async balancesForProduct(productId: string) {
    const product = await this.prisma.db.product.findFirst({
      where: { id: productId },
      select: { id: true, sku: true, name: true },
    });
    if (!product) throw new NotFoundError('Product', productId);

    const rows = await this.prisma.db.stockBalance.findMany({
      where: { productId },
      orderBy: [{ warehouse: { code: 'asc' } }],
      select: BALANCE_SELECT,
    });

    const totalOnHand = Money.sum(rows.map((r) => r.quantityOnHand.toFixed(4)));
    const totalReserved = Money.sum(rows.map((r) => r.quantityReserved.toFixed(4)));

    return {
      product,
      totals: {
        onHand: totalOnHand.toString(),
        reserved: totalReserved.toString(),
        available: totalOnHand.subtract(totalReserved).toString(),
      },
      byWarehouse: rows.map((row) => toBalanceSummary(row, new Map())),
    };
  }

  /** The audit trail: why is stock 47? */
  async listLedger(query: ListLedgerQuery) {
    const where: Prisma.StockLedgerEntryWhereInput = {
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.movementType ? { movementType: query.movementType } : {}),
      ...(query.refType ? { refType: query.refType } : {}),
      ...(query.refId ? { refId: query.refId } : {}),
    };

    if (query.from || query.to) {
      where.occurredAt = {
        ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
        ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
      };
    }

    const cursorWhere = keysetWhere(query.cursor);
    const rows = await this.prisma.db.stockLedgerEntry.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: LEDGER_SELECT,
    });

    const totalCount = query.includeTotal
      ? await this.prisma.db.stockLedgerEntry.count({ where })
      : undefined;

    // `toListResult` keys on createdAt; ledger rows carry both and they are set
    // together, so the cursor stays consistent with the occurredAt ordering for
    // everything except deliberately backdated entries.
    const result = toListResult(
      rows.map((row) => ({ ...row, createdAt: row.occurredAt })),
      query.limit,
      totalCount,
    );

    return {
      ...result,
      data: result.data.map((row) => ({
        id: row.id,
        warehouseId: row.warehouseId,
        warehouseCode: row.warehouse.code,
        productId: row.productId,
        sku: row.product.sku,
        productName: row.product.name,
        movementType: row.movementType,
        quantity: row.quantity.toFixed(4),
        unitCost: row.unitCost.toFixed(4),
        refType: row.refType,
        refId: row.refId,
        reason: row.reason,
        occurredAt: row.occurredAt,
        createdById: row.createdById,
      })),
    };
  }

  // ── Movements ─────────────────────────────────────────────────────────────

  async receive(dto: GoodsReceiptDto, actorId: string) {
    await this.assertWarehouseVisible(dto.warehouseId);
    await this.assertProductsExist(dto.lines.map((line) => line.productId));

    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : this.clock.now();

    return this.prisma.transaction(async (tx) => {
      const results = [];
      for (const line of dto.lines) {
        const result = await this.ledger.move(tx, {
          warehouseId: dto.warehouseId,
          productId: line.productId,
          variantId: line.variantId ?? null,
          batchId: line.batchId ?? null,
          movementType: 'RECEIPT',
          quantity: line.quantity,
          unitCost: line.unitCost ?? null,
          refType: dto.refType ?? 'RECEIPT',
          refId: dto.refId ?? null,
          occurredAt,
          actorId,
        });
        results.push({ productId: line.productId, ...result });
      }

      await this.audit.record(tx, {
        action: 'inventory.goods_received',
        entityType: 'Warehouse',
        entityId: dto.warehouseId,
        after: { lines: dto.lines.length, refType: dto.refType ?? null },
        metadata: { actorId, notes: dto.notes },
      });

      return { received: results.length, lines: results };
    });
  }

  /**
   * Issues stock out of a warehouse.
   *
   * For a serialized product this demands one serial per unit (ADR-0009). The
   * count is checked before any movement, so a short serial list fails the
   * whole issue rather than shipping some units untraceable.
   */
  async issue(dto: StockIssueDto, actorId: string) {
    await this.assertWarehouseVisible(dto.warehouseId);
    const products = await this.assertProductsExist(dto.lines.map((line) => line.productId));

    // Validate serials up front — outside the transaction, so an obvious
    // mistake is rejected without taking row locks.
    for (const line of dto.lines) {
      const product = products.get(line.productId);
      if (!product?.isSerialized) continue;

      const expected = Money.of(line.quantity);
      const supplied = line.serials?.length ?? 0;

      if (!Money.of(String(supplied)).equals(expected)) {
        throw new ConflictError(
          `${product.sku} is serial-tracked: ${expected.toDisplayString()} unit(s) require ` +
            `exactly that many serial numbers, but ${supplied} were supplied. ` +
            'Serials are recorded at dispatch so every unit stays traceable to its plant.',
        );
      }
    }

    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : this.clock.now();

    return this.prisma.transaction(async (tx) => {
      const results = [];
      for (const line of dto.lines) {
        const result = await this.ledger.move(tx, {
          warehouseId: dto.warehouseId,
          productId: line.productId,
          variantId: line.variantId ?? null,
          batchId: line.batchId ?? null,
          movementType: 'ISSUE',
          quantity: line.quantity,
          refType: dto.refType ?? 'ISSUE',
          refId: dto.refId ?? null,
          occurredAt,
          actorId,
        });

        if (line.serials?.length) {
          await this.serials.recordDispatched(tx, {
            productId: line.productId,
            serials: line.serials,
            distributorId: dto.distributorId ?? null,
            batchId: line.batchId ?? null,
            dispatchedAt: occurredAt,
            actorId,
          });
        }

        results.push({ productId: line.productId, ...result });
      }

      await this.audit.record(tx, {
        action: 'inventory.stock_issued',
        entityType: 'Warehouse',
        entityId: dto.warehouseId,
        after: { lines: dto.lines.length, distributorId: dto.distributorId ?? null },
        metadata: { actorId, notes: dto.notes },
      });

      return { issued: results.length, lines: results };
    });
  }

  /**
   * A signed correction with a mandatory reason.
   *
   * Its own endpoint and its own permission because this is the one operation
   * that can create or destroy stock without a corresponding physical event.
   * Every adjustment is a SECURITY audit entry for that reason.
   */
  async adjust(dto: StockAdjustmentDto, actorId: string) {
    await this.assertWarehouseVisible(dto.warehouseId);
    await this.assertProductsExist([dto.productId]);

    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : this.clock.now();
    const reason = `${dto.reasonCode}: ${dto.reason}`;

    const result = await this.prisma.transaction(async (tx) => {
      const moved = await this.ledger.move(tx, {
        warehouseId: dto.warehouseId,
        productId: dto.productId,
        variantId: dto.variantId ?? null,
        batchId: dto.batchId ?? null,
        movementType: 'ADJUSTMENT',
        quantity: dto.quantity,
        reason,
        refType: 'ADJUSTMENT',
        occurredAt,
        actorId,
      });

      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'inventory.stock_adjusted',
        entityType: 'Warehouse',
        entityId: dto.warehouseId,
        after: {
          productId: dto.productId,
          quantity: dto.quantity,
          reasonCode: dto.reasonCode,
          newOnHand: moved.quantityOnHand,
        },
        metadata: { actorId, reason: dto.reason },
      });

      return moved;
    });

    this.logger.warn(
      { warehouseId: dto.warehouseId, productId: dto.productId, quantity: dto.quantity, actorId },
      'Stock adjusted',
    );
    return result;
  }

  /**
   * Bulk OPENING entries.
   *
   * The owner chose to start the ledger empty, so this exists for the day real
   * figures are loaded — a stock take, or a migration from a spreadsheet.
   * Refused where stock already moved: an opening balance posted after trading
   * has begun is not an opening balance, it is an unexplained adjustment.
   */
  async openingBalances(dto: OpeningBalanceDto, actorId: string) {
    await this.assertWarehouseVisible(dto.warehouseId);
    await this.assertProductsExist(dto.lines.map((line) => line.productId));

    const existing = await this.prisma.db.stockLedgerEntry.findFirst({
      where: {
        warehouseId: dto.warehouseId,
        productId: { in: dto.lines.map((line) => line.productId) },
      },
      select: { productId: true, movementType: true },
    });
    if (existing) {
      throw new ConflictError(
        'One or more of these products already has movement history in this warehouse. ' +
          'Post a stock adjustment with a reason instead — an opening balance after trading ' +
          'has begun would misrepresent when the stock arrived.',
      );
    }

    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : this.clock.now();

    return this.prisma.transaction(async (tx) => {
      const results = [];
      for (const line of dto.lines) {
        results.push(
          await this.ledger.move(tx, {
            warehouseId: dto.warehouseId,
            productId: line.productId,
            variantId: line.variantId ?? null,
            batchId: line.batchId ?? null,
            movementType: 'OPENING',
            quantity: line.quantity,
            unitCost: line.unitCost ?? null,
            refType: 'OPENING',
            occurredAt,
            actorId,
          }),
        );
      }

      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'inventory.opening_balances_posted',
        entityType: 'Warehouse',
        entityId: dto.warehouseId,
        after: { lines: dto.lines.length },
        metadata: { actorId, notes: dto.notes },
      });

      return { posted: results.length };
    });
  }

  // ── Transfers ─────────────────────────────────────────────────────────────

  async createTransfer(dto: CreateTransferDto, actorId: string) {
    await this.assertWarehouseVisible(dto.sourceWarehouseId);
    await this.assertWarehouseVisible(dto.destinationWarehouseId);
    await this.assertProductsExist(dto.lines.map((line) => line.productId));

    return this.prisma.transaction(async (tx) => {
      const code = await this.sequences.next(tx, 'TRANSFER');

      const transfer = await tx.stockTransfer.create({
        data: {
          code,
          status: 'DRAFT',
          sourceWarehouseId: dto.sourceWarehouseId,
          destinationWarehouseId: dto.destinationWarehouseId,
          transitWarehouseId: dto.transitWarehouseId ?? null,
          notes: dto.notes ?? null,
          createdById: actorId,
          lines: {
            createMany: {
              data: dto.lines.map((line) => ({
                productId: line.productId,
                variantId: line.variantId ?? null,
                quantity: line.quantity,
              })),
            },
          },
        },
        select: TRANSFER_SELECT,
      });

      await this.audit.record(tx, {
        action: 'inventory.transfer_created',
        entityType: 'StockTransfer',
        entityId: transfer.id,
        after: { code, lines: dto.lines.length },
      });

      return toTransferSummary(transfer);
    });
  }

  /**
   * Phase one: stock leaves the source and rests in transit.
   *
   * Two phases rather than one so goods are VISIBLE while they are moving. A
   * single-phase transfer makes stock vanish for however long the lorry takes,
   * and every such gap gets reported as a bug by someone looking for it.
   */
  async dispatchTransfer(id: string, actorId: string) {
    const transfer = await this.loadTransfer(id);
    this.assertTransferTransition(transfer.status, 'IN_TRANSIT');

    const transitWarehouseId = transfer.transitWarehouseId ?? transfer.sourceWarehouseId;
    const occurredAt = this.clock.now();

    const updated = await this.prisma.transaction(async (tx) => {
      for (const line of transfer.lines) {
        // Out of the source…
        const out = await this.ledger.move(tx, {
          warehouseId: transfer.sourceWarehouseId,
          productId: line.productId,
          variantId: line.variantId,
          movementType: 'TRANSFER_OUT',
          quantity: line.quantity.toFixed(4),
          refType: 'TRANSFER',
          refId: transfer.id,
          occurredAt,
          actorId,
        });

        // …and into transit at the SOURCE's average cost (ADR-0010 §6).
        // Without carrying the cost across, the destination receives the goods
        // valued at zero and the transfer silently destroys inventory value.
        // Outbound movements never change the average, so the figure returned
        // by the move above is still the source's cost for these units.
        if (transitWarehouseId !== transfer.sourceWarehouseId) {
          await this.ledger.move(tx, {
            warehouseId: transitWarehouseId,
            productId: line.productId,
            variantId: line.variantId,
            movementType: 'TRANSFER_IN',
            quantity: line.quantity.toFixed(4),
            unitCost: out.averageCost,
            refType: 'TRANSFER',
            refId: transfer.id,
            occurredAt,
            actorId,
          });
        }
      }

      const result = await tx.stockTransfer.update({
        where: { id },
        data: { status: 'IN_TRANSIT', dispatchedAt: occurredAt },
        select: TRANSFER_SELECT,
      });

      await this.audit.record(tx, {
        action: 'inventory.transfer_dispatched',
        entityType: 'StockTransfer',
        entityId: id,
        before: { status: transfer.status },
        after: { status: 'IN_TRANSIT' },
        metadata: { actorId },
      });

      return result;
    });

    return toTransferSummary(updated);
  }

  /** Phase two: stock arrives. Short receipts are recorded, not hidden. */
  async receiveTransfer(
    id: string,
    lines: ReadonlyArray<{ productId: string; quantityReceived: string }>,
    actorId: string,
  ) {
    const transfer = await this.loadTransfer(id);
    this.assertTransferTransition(transfer.status, 'RECEIVED');

    const transitWarehouseId = transfer.transitWarehouseId ?? transfer.sourceWarehouseId;
    const received = new Map(lines.map((line) => [line.productId, line.quantityReceived]));
    const occurredAt = this.clock.now();

    const updated = await this.prisma.transaction(async (tx) => {
      for (const line of transfer.lines) {
        const qty = received.get(line.productId) ?? line.quantity.toFixed(4);

        if (Money.of(qty).gt(line.quantity.toFixed(4))) {
          throw new ConflictError(
            `Cannot receive more than was dispatched for this line ` +
              `(${qty} received vs ${line.quantity.toFixed(4)} sent).`,
          );
        }

        // The cost travels with the goods (ADR-0010 §6). Where a transit
        // warehouse is in play the stock leaves IT, so its average is the one
        // that carries; otherwise the source's does.
        const originWarehouseId =
          transitWarehouseId !== transfer.sourceWarehouseId
            ? transitWarehouseId
            : transfer.sourceWarehouseId;

        let carriedCost = await this.averageCostAt(tx, originWarehouseId, line.productId, line.variantId);

        if (transitWarehouseId !== transfer.sourceWarehouseId) {
          const out = await this.ledger.move(tx, {
            warehouseId: transitWarehouseId,
            productId: line.productId,
            variantId: line.variantId,
            movementType: 'TRANSFER_OUT',
            quantity: qty,
            refType: 'TRANSFER',
            refId: transfer.id,
            occurredAt,
            actorId,
          });
          carriedCost = out.averageCost;
        }

        await this.ledger.move(tx, {
          warehouseId: transfer.destinationWarehouseId,
          productId: line.productId,
          variantId: line.variantId,
          movementType: 'TRANSFER_IN',
          quantity: qty,
          unitCost: carriedCost,
          refType: 'TRANSFER',
          refId: transfer.id,
          occurredAt,
          actorId,
        });

        await tx.stockTransferLine.update({
          where: { id: line.id },
          data: { quantityReceived: qty },
        });
      }

      const result = await tx.stockTransfer.update({
        where: { id },
        data: { status: 'RECEIVED', receivedAt: occurredAt },
        select: TRANSFER_SELECT,
      });

      await this.audit.record(tx, {
        action: 'inventory.transfer_received',
        entityType: 'StockTransfer',
        entityId: id,
        before: { status: transfer.status },
        after: { status: 'RECEIVED' },
        metadata: { actorId },
      });

      return result;
    });

    return toTransferSummary(updated);
  }

  // ── Low stock ─────────────────────────────────────────────────────────────

  async lowStock(warehouseId?: string) {
    const settings = await this.prisma.db.inventorySetting.findMany({
      where: {
        alertEnabled: true,
        ...(warehouseId ? { warehouseId } : {}),
      },
      select: {
        productId: true,
        warehouseId: true,
        reorderLevel: true,
        reorderQuantity: true,
        product: { select: { sku: true, name: true, leadTimeDays: true } },
        warehouse: { select: { code: true, name: true } },
      },
    });
    if (settings.length === 0) return { data: [] };

    const balances = await this.prisma.db.stockBalance.findMany({
      where: {
        OR: settings.map((s) => ({ productId: s.productId, warehouseId: s.warehouseId })),
      },
      select: {
        productId: true,
        warehouseId: true,
        quantityOnHand: true,
        quantityReserved: true,
        quantityAvailable: true,
      },
    });
    const byKey = new Map(balances.map((b) => [`${b.warehouseId}:${b.productId}`, b]));

    const data = settings
      .map((setting) => {
        const balance = byKey.get(`${setting.warehouseId}:${setting.productId}`);
        // A product with a reorder level but no balance row has never been
        // stocked — which is exactly the case worth alerting on, at zero.
        const available = balance?.quantityAvailable?.toFixed(4) ?? '0.0000';
        return {
          productId: setting.productId,
          sku: setting.product.sku,
          productName: setting.product.name,
          warehouseId: setting.warehouseId,
          warehouseCode: setting.warehouse.code,
          quantityAvailable: available,
          reorderLevel: setting.reorderLevel.toFixed(4),
          reorderQuantity: setting.reorderQuantity.toFixed(4),
          leadTimeDays: setting.product.leadTimeDays,
          shortfall: Money.of(setting.reorderLevel.toFixed(4)).subtract(available).toString(),
        };
      })
      .filter((row) => Money.of(row.quantityAvailable).lte(row.reorderLevel));

    return { data };
  }

  /** Raised by the maintenance job so a low-stock alert reaches a human. */
  async emitLowStockAlerts(): Promise<number> {
    const { data } = await this.lowStock();
    if (data.length === 0) return 0;

    await this.prisma.transaction(async (tx) => {
      for (const row of data) {
        await this.outbox.emit(
          tx,
          DOMAIN_EVENTS.STOCK_LOW,
          { type: 'Product', id: row.productId },
          {
            sku: row.sku,
            warehouse: row.warehouseCode,
            available: row.quantityAvailable,
            reorderLevel: row.reorderLevel,
          },
        );
      }
    });

    return data.length;
  }

  // ── Guards ────────────────────────────────────────────────────────────────

  /**
   * Confirms the warehouse is visible to THIS caller.
   *
   * Reads through the scoped client, so a warehouse outside the caller's
   * territory does not exist as far as they are concerned and the 404 is
   * correct. This is what stops a territory-scoped user posting movements into
   * a warehouse they cannot see — the scope extension filters reads, but an
   * INSERT carries its warehouseId in the request body and has nothing to
   * filter against. Same pattern as DistributorCatalogService.
   */
  private async assertWarehouseVisible(warehouseId: string): Promise<void> {
    const warehouse = await this.prisma.db.warehouse.findFirst({
      where: { id: warehouseId },
      select: { id: true, isActive: true, code: true },
    });
    if (!warehouse) throw new NotFoundError('Warehouse', warehouseId);
    if (!warehouse.isActive) {
      throw new ConflictError(`Warehouse ${warehouse.code} is inactive and cannot receive stock.`);
    }
  }

  private async assertProductsExist(productIds: readonly string[]) {
    const unique = [...new Set(productIds)];
    const products = await this.prisma.db.product.findMany({
      where: { id: { in: unique } },
      select: { id: true, sku: true, isSerialized: true, isBatchTracked: true, status: true },
    });
    if (products.length !== unique.length) {
      const known = new Set(products.map((p) => p.id));
      throw new NotFoundError('Product', unique.filter((id) => !known.has(id)).join(', '));
    }
    return new Map(products.map((p) => [p.id, p]));
  }

  /**
   * The average cost held at a warehouse for a product, or '0' if none.
   *
   * Used to carry cost across a transfer. Read rather than assumed, because the
   * source's average is what those units actually cost.
   */
  private async averageCostAt(
    tx: PrismaTransaction,
    warehouseId: string,
    productId: string,
    variantId: string | null,
  ): Promise<string> {
    const balance = await tx.stockBalance.findFirst({
      where: { warehouseId, productId, variantId },
      select: { averageCost: true },
    });
    return balance?.averageCost.toFixed(4) ?? '0';
  }

  private async loadTransfer(id: string) {
    const transfer = await this.prisma.db.stockTransfer.findFirst({
      where: { id },
      select: {
        id: true,
        code: true,
        status: true,
        sourceWarehouseId: true,
        destinationWarehouseId: true,
        transitWarehouseId: true,
        lines: {
          select: { id: true, productId: true, variantId: true, quantity: true },
        },
      },
    });
    if (!transfer) throw new NotFoundError('StockTransfer', id);
    return transfer;
  }

  private assertTransferTransition(from: string, to: 'IN_TRANSIT' | 'RECEIVED'): void {
    if (!canTransitionTransfer(from as never, to)) {
      throw new ConflictError(
        `A transfer cannot move from ${from} to ${to}. Stock cannot arrive without having been dispatched.`,
      );
    }
  }
}

// ── Row shapes ──────────────────────────────────────────────────────────────

const BALANCE_SELECT = {
  id: true,
  warehouseId: true,
  productId: true,
  variantId: true,
  batchId: true,
  quantityOnHand: true,
  quantityReserved: true,
  quantityAvailable: true,
  averageCost: true,
  lastMovementAt: true,
  warehouse: { select: { code: true, name: true } },
  product: { select: { sku: true, name: true } },
} satisfies Prisma.StockBalanceSelect;

const LEDGER_SELECT = {
  id: true,
  warehouseId: true,
  productId: true,
  movementType: true,
  quantity: true,
  unitCost: true,
  refType: true,
  refId: true,
  reason: true,
  occurredAt: true,
  createdById: true,
  warehouse: { select: { code: true } },
  product: { select: { sku: true, name: true } },
} satisfies Prisma.StockLedgerEntrySelect;

const TRANSFER_SELECT = {
  id: true,
  code: true,
  status: true,
  sourceWarehouseId: true,
  destinationWarehouseId: true,
  dispatchedAt: true,
  receivedAt: true,
  createdAt: true,
  source: { select: { name: true } },
  destination: { select: { name: true } },
  lines: { select: { quantity: true } },
} satisfies Prisma.StockTransferSelect;

type BalanceRow = Prisma.StockBalanceGetPayload<{ select: typeof BALANCE_SELECT }>;
type TransferRow = Prisma.StockTransferGetPayload<{ select: typeof TRANSFER_SELECT }>;

function toBalanceSummary(row: BalanceRow, levels: Map<string, string>) {
  const onHand = Money.of(row.quantityOnHand.toFixed(4));
  const available = Money.of(row.quantityAvailable?.toFixed(4) ?? '0');
  const reorderLevel = levels.get(`${row.warehouseId}:${row.productId}`) ?? null;

  return {
    id: row.id,
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouse.code,
    warehouseName: row.warehouse.name,
    productId: row.productId,
    sku: row.product.sku,
    productName: row.product.name,
    variantId: row.variantId,
    batchId: row.batchId,
    quantityOnHand: onHand.toString(),
    quantityReserved: row.quantityReserved.toFixed(4),
    quantityAvailable: available.toString(),
    averageCost: row.averageCost.toFixed(4),
    stockValue: stockValue(onHand, Money.of(row.averageCost.toFixed(4))).toString(),
    reorderLevel,
    isBelowReorderLevel: reorderLevel !== null && available.lte(reorderLevel),
    lastMovementAt: row.lastMovementAt,
  };
}

function toTransferSummary(row: TransferRow) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    sourceWarehouseId: row.sourceWarehouseId,
    sourceWarehouseName: row.source.name,
    destinationWarehouseId: row.destinationWarehouseId,
    destinationWarehouseName: row.destination.name,
    lineCount: row.lines.length,
    totalQuantity: Money.sum(row.lines.map((line) => line.quantity.toFixed(4))).toString(),
    dispatchedAt: row.dispatchedAt,
    receivedAt: row.receivedAt,
    createdAt: row.createdAt,
  };
}
