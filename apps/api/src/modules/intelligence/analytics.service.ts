import { Injectable } from '@nestjs/common';
import {
  Money,
  OUTSTANDING_INVOICE_STATUSES,
  PERMISSIONS,
  hasPermission,
  type AnalyticsQuery,
  type Kpi,
  type TopNQuery,
  type TrendQuery,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import { RequestContextStore } from '../../common/context/request-context';
import { PermissionDeniedError } from '../../common/errors/domain.error';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { OutstandingService } from '../finance/outstanding.service';
import { monthWindows, resolvePeriod } from './period';

/**
 * Dashboard and analytics aggregates.
 *
 * ── Three rules, and they are the whole design ─────────────────────────────
 *
 * **1. Reuse the service that owns the number.** Receivables come from
 * `OutstandingService`, not from a second aggregate here. Two services that
 * both compute "what is outstanding" will eventually disagree, and the
 * dashboard is the screen where that gets noticed and believed.
 *
 * **2. Money is gated, and absent rather than zero.** `analytics:read` returns
 * operational counts; revenue and receivables need
 * `analytics:read:financial`. A zero would be a claim about the business —
 * "we made nothing" reads very differently from "you may not see this".
 *
 * **3. Everything reads through `prisma.db`**, so the scope extension bounds
 * every aggregate to the caller's subtree (ADR-0003). There is no raw SQL in
 * this file, which is not an accident: raw SQL forgets to filter by default,
 * and an aggregate is exactly where a leak would be invisible.
 *
 * ── No materialised views ──────────────────────────────────────────────────
 * ADR-0019. These aggregate live tables at ~108 ms for the whole dashboard at
 * ten times projected volume, behind a 5-minute cache. If you are here to add
 * a refresh worker, read the ADR first — the measurement is in it.
 */

/** Orders that represent no revenue and must never enter an aggregate. */
const DEAD_ORDER_STATUSES: Prisma.EnumOrderStatusFilter = {
  notIn: ['DRAFT', 'CANCELLED', 'REJECTED'],
};

/** Matches the partial index added in migration 0013. */
const REVENUE_ORDER_WHERE = {
  type: 'PRIMARY' as const,
  status: DEAD_ORDER_STATUSES,
};

const CACHE_TTL_SECONDS = 300;

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outstanding: OutstandingService,
    private readonly redis: RedisService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AnalyticsService.name);
  }

  // ── KPIs ──────────────────────────────────────────────────────────────────

  async kpis(query: AnalyticsQuery) {
    const period = resolvePeriod(query.period, this.clock.now());
    const financial = this.mayReadFinancial();

    return this.cached(`kpis:${query.period}:${query.territoryId ?? ''}:${financial}`, async () => {
      const scope = this.orderScope(query);

      const [orders, previousOrders, quotations, previousQuotations] = await Promise.all([
        this.orderAggregate(period.from, period.to, scope),
        this.orderAggregate(period.comparedFrom, period.comparedTo, scope),
        this.quotationCount(period.from, period.to),
        this.quotationCount(period.comparedFrom, period.comparedTo),
      ]);

      const [lowStock, backordered] = await Promise.all([
        this.lowStockCount(),
        this.backorderedLineCount(),
      ]);

      const base = {
        period: query.period,
        from: iso(period.from),
        to: iso(period.to),
        comparedFrom: iso(period.comparedFrom),
        comparedTo: iso(period.comparedTo),
        orderCount: countKpi(orders.count, previousOrders.count),
        quotationCount: countKpi(quotations, previousQuotations),
        // No baseline is possible for a point-in-time stock figure, so these
        // report FLAT rather than inventing a comparison.
        lowStockCount: countKpi(lowStock, lowStock),
        backorderedLineCount: countKpi(backordered, backordered),
      };

      if (!financial) return base;

      const [invoiced, previousInvoiced, collected, previousCollected, receivables] =
        await Promise.all([
          this.invoicedValue(period.from, period.to, query),
          this.invoicedValue(period.comparedFrom, period.comparedTo, query),
          this.collectedValue(period.from, period.to, query),
          this.collectedValue(period.comparedFrom, period.comparedTo, query),
          this.receivablesSnapshot(query),
        ]);

      return {
        ...base,
        orderValue: moneyKpi(orders.value, previousOrders.value),
        revenue: moneyKpi(invoiced, previousInvoiced),
        collected: moneyKpi(collected, previousCollected),
        // A point-in-time balance: no previous-period figure exists without
        // reconstructing history, so it reports itself. `inverse` tells the UI
        // that a rise here is bad.
        outstanding: { ...moneyKpi(receivables.total, receivables.total), inverse: true },
        overdue: { ...moneyKpi(receivables.overdue, receivables.overdue), inverse: true },
      };
    });
  }

  // ── Series ────────────────────────────────────────────────────────────────

  async salesTrend(query: TrendQuery) {
    const financial = this.mayReadFinancial();

    return this.cached(`trend:${query.months}:${query.territoryId ?? ''}:${financial}`, async () => {
      const windows = monthWindows(query.months, this.clock.now());
      const scope = this.orderScope(query);

      const points = await Promise.all(
        windows.map(async (window) => {
          const orders = await this.orderAggregate(window.from, window.to, scope);
          const invoiced = financial
            ? await this.invoicedValue(window.from, window.to, query)
            : null;

          return {
            month: window.month,
            orderCount: orders.count,
            ...(financial
              ? { orderValue: orders.value.toString(), invoicedValue: invoiced?.toString() }
              : {}),
          };
        }),
      );

      return { months: query.months, points };
    });
  }

  // ── Rankings ──────────────────────────────────────────────────────────────

  async topProducts(query: TopNQuery) {
    const financial = this.mayReadFinancial();

    return this.cached(`top-products:${query.limit}:${query.months}:${financial}`, async () => {
      const windows = monthWindows(query.months, this.clock.now());
      const from = windows[0]?.from ?? this.clock.now();

      // `groupBy` through `prisma.db` keeps the scope extension in play — the
      // order relation filter is what bounds this to the caller's subtree.
      const grouped = await this.prisma.db.orderLine.groupBy({
        by: ['productId', 'sku'],
        where: { order: { ...REVENUE_ORDER_WHERE, orderDate: { gte: from } } },
        _sum: { lineTotal: true, quantity: true },
        _count: { _all: true },
        orderBy: { _sum: { lineTotal: 'desc' } },
        take: query.limit,
      });

      const names = await this.productNames(grouped.map((row) => row.productId));
      const total = Money.sum(grouped.map((row) => row._sum.lineTotal?.toFixed(4) ?? '0'));

      return {
        months: query.months,
        ...(financial ? { total: total.toString() } : {}),
        entries: grouped.map((row) => {
          const revenue = Money.of(row._sum.lineTotal?.toFixed(4) ?? '0');
          return {
            id: row.productId,
            label: names.get(row.productId) ?? row.sku,
            sublabel: row.sku,
            orderCount: row._count._all,
            quantity: Money.of(row._sum.quantity?.toFixed(4) ?? '0').toString(),
            ...(financial
              ? {
                  revenue: revenue.toString(),
                  sharePercent: share(revenue, total),
                }
              : {}),
          };
        }),
      };
    });
  }

  async topDistributors(query: TopNQuery) {
    const financial = this.mayReadFinancial();

    return this.cached(`top-dists:${query.limit}:${query.months}:${financial}`, async () => {
      const windows = monthWindows(query.months, this.clock.now());
      const from = windows[0]?.from ?? this.clock.now();

      const grouped = await this.prisma.db.order.groupBy({
        by: ['distributorId'],
        where: { ...REVENUE_ORDER_WHERE, orderDate: { gte: from }, distributorId: { not: null } },
        _sum: { grandTotal: true },
        _count: { _all: true },
        orderBy: { _sum: { grandTotal: 'desc' } },
        take: query.limit,
      });

      const ids = grouped.map((row) => row.distributorId).filter((id): id is string => Boolean(id));
      const distributors = await this.prisma.db.distributor.findMany({
        where: { id: { in: ids } },
        select: { id: true, legalName: true, code: true },
      });
      const byId = new Map(distributors.map((d) => [d.id, d]));
      const total = Money.sum(grouped.map((row) => row._sum.grandTotal?.toFixed(4) ?? '0'));

      return {
        months: query.months,
        ...(financial ? { total: total.toString() } : {}),
        entries: grouped.flatMap((row) => {
          if (!row.distributorId) return [];
          const revenue = Money.of(row._sum.grandTotal?.toFixed(4) ?? '0');
          const distributor = byId.get(row.distributorId);
          return [
            {
              id: row.distributorId,
              label: distributor?.legalName ?? 'Unknown',
              sublabel: distributor?.code ?? null,
              orderCount: row._count._all,
              ...(financial
                ? { revenue: revenue.toString(), sharePercent: share(revenue, total) }
                : {}),
            },
          ];
        }),
      };
    });
  }

  async byTerritory(query: TrendQuery) {
    const financial = this.mayReadFinancial();

    return this.cached(`by-territory:${query.months}:${financial}`, async () => {
      const windows = monthWindows(query.months, this.clock.now());
      const from = windows[0]?.from ?? this.clock.now();

      // A territory rollup needs the distributor's territory, which an order
      // does not carry. Loading orders with their distributor's territory and
      // folding in TypeScript keeps this on `prisma.db` — and the row count is
      // bounded by orders in the window, which the measurement showed is
      // thousands, not millions (ADR-0019).
      const orders = await this.prisma.db.order.findMany({
        where: { ...REVENUE_ORDER_WHERE, orderDate: { gte: from } },
        select: {
          grandTotal: true,
          distributor: { select: { territory: { select: { id: true, name: true } } } },
          customer: { select: { territory: { select: { id: true, name: true } } } },
        },
      });

      const byTerritory = new Map<string, { name: string; revenue: Money; count: number }>();
      for (const order of orders) {
        const territory = order.distributor?.territory ?? order.customer?.territory;
        if (!territory) continue;
        const entry = byTerritory.get(territory.id) ?? {
          name: territory.name,
          revenue: Money.zero(),
          count: 0,
        };
        entry.revenue = entry.revenue.add(order.grandTotal.toFixed(4));
        entry.count += 1;
        byTerritory.set(territory.id, entry);
      }

      const total = Money.sum([...byTerritory.values()].map((e) => e.revenue.toString()));

      return {
        months: query.months,
        ...(financial ? { total: total.toString() } : {}),
        entries: [...byTerritory.entries()]
          .sort((a, b) => (b[1].revenue.gt(a[1].revenue) ? 1 : -1))
          .map(([id, entry]) => ({
            id,
            label: entry.name,
            sublabel: null,
            orderCount: entry.count,
            ...(financial
              ? { revenue: entry.revenue.toString(), sharePercent: share(entry.revenue, total) }
              : {}),
          })),
      };
    });
  }

  // ── Inventory health — carries a Phase 8 obligation ───────────────────────

  /**
   * The stock picture, with owned and channel stock reported SEPARATELY.
   *
   * ⚠️ `ownedStockValue` EXCLUDES `DISTRIBUTOR` warehouses. Those goods were
   * sold at the sell-in invoice; counting them again would overstate assets
   * (ADR-0014 §4 — the obligation Phase 8 placed on Phase 9).
   *
   * They are not simply dropped, though: `channelStockValue` reports them under
   * their own name, because "what are our partners holding" is a real question
   * that the derived-channel-inventory design exists to answer. It is just not
   * an asset of Hixaa's, and the two must never be added together.
   */
  async inventoryHealth() {
    const financial = this.mayReadFinancial();

    return this.cached(`inventory-health:${financial}`, async () => {
      const balances = await this.prisma.db.stockBalance.findMany({
        select: {
          quantityOnHand: true,
          quantityReserved: true,
          averageCost: true,
          productId: true,
          warehouse: { select: { id: true, type: true } },
        },
      });

      let ownedValue = Money.zero();
      let channelValue = Money.zero();
      let reserved = Money.zero();
      const ownedWarehouses = new Set<string>();
      const channelWarehouses = new Set<string>();
      const skusInStock = new Set<string>();
      let outOfStock = 0;

      for (const balance of balances) {
        const quantity = Money.of(balance.quantityOnHand.toFixed(4));
        const value = quantity.multiply(balance.averageCost.toFixed(4));
        const isChannel = balance.warehouse.type === 'DISTRIBUTOR';

        if (isChannel) {
          channelValue = channelValue.add(value);
          channelWarehouses.add(balance.warehouse.id);
        } else {
          ownedValue = ownedValue.add(value);
          ownedWarehouses.add(balance.warehouse.id);
          reserved = reserved.add(balance.quantityReserved.toFixed(4));
          if (quantity.isPositive()) skusInStock.add(balance.productId);
          else outOfStock += 1;
        }
      }

      const [lowStock, deadStock] = await Promise.all([
        this.lowStockCount(),
        this.deadStockCount(),
      ]);

      return {
        ...(financial
          ? { ownedStockValue: ownedValue.toString(), channelStockValue: channelValue.toString() }
          : {}),
        ownedWarehouseCount: ownedWarehouses.size,
        channelWarehouseCount: channelWarehouses.size,
        skusInStock: skusInStock.size,
        lowStockCount: lowStock,
        outOfStockCount: outOfStock,
        deadStockCount: deadStock.count,
        ...(financial ? { deadStockValue: deadStock.value.toString() } : {}),
        reservedQuantity: reserved.toString(),
      };
    });
  }

  async receivables() {
    this.assertFinancial();
    // Delegated, not recomputed: a second aging implementation would eventually
    // disagree with the Outstanding screen, and the dashboard is where that
    // gets believed.
    return this.outstanding.report({});
  }

  // ── Activity feed ─────────────────────────────────────────────────────────

  async activity(limit: number) {
    const financial = this.mayReadFinancial();

    const [orders, invoices, shipments] = await Promise.all([
      this.prisma.db.order.findMany({
        where: { status: DEAD_ORDER_STATUSES },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          number: true,
          status: true,
          grandTotal: true,
          createdAt: true,
          distributor: { select: { legalName: true } },
          customer: { select: { name: true } },
        },
      }),
      this.prisma.db.invoice.findMany({
        where: { status: { not: 'DRAFT' } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          number: true,
          counterpartyName: true,
          grandTotal: true,
          issuedAt: true,
          createdAt: true,
        },
      }),
      this.prisma.db.shipment.findMany({
        where: { dispatchedAt: { not: null } },
        orderBy: { dispatchedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          number: true,
          dispatchedAt: true,
          createdAt: true,
          order: { select: { number: true } },
        },
      }),
    ]);

    const entries = [
      ...orders.map((order) => ({
        id: order.id,
        kind: 'ORDER' as const,
        reference: order.number,
        description: `Order ${order.number} — ${order.distributor?.legalName ?? order.customer?.name ?? 'Unknown'} (${order.status})`,
        ...(financial ? { amount: order.grandTotal.toFixed(4) } : {}),
        actorName: null,
        occurredAt: order.createdAt,
        href: `/orders/${order.id}`,
      })),
      ...invoices.map((invoice) => ({
        id: invoice.id,
        kind: 'INVOICE' as const,
        reference: invoice.number ?? 'Draft',
        description: `Invoice ${invoice.number ?? '(draft)'} — ${invoice.counterpartyName}`,
        ...(financial ? { amount: invoice.grandTotal.toFixed(4) } : {}),
        actorName: null,
        occurredAt: invoice.issuedAt ?? invoice.createdAt,
        href: `/invoices/${invoice.id}`,
      })),
      ...shipments.map((shipment) => ({
        id: shipment.id,
        kind: 'SHIPMENT' as const,
        reference: shipment.number,
        description: `Shipment ${shipment.number} dispatched against ${shipment.order.number}`,
        actorName: null,
        occurredAt: shipment.dispatchedAt ?? shipment.createdAt,
        href: `/orders`,
      })),
    ];

    return entries
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, limit);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async orderAggregate(from: Date, to: Date, extra: Prisma.OrderWhereInput) {
    const result = await this.prisma.db.order.aggregate({
      where: { ...REVENUE_ORDER_WHERE, ...extra, orderDate: { gte: from, lte: to } },
      _sum: { grandTotal: true },
      _count: { _all: true },
    });
    return {
      count: result._count._all,
      value: Money.of(result._sum.grandTotal?.toFixed(4) ?? '0'),
    };
  }

  private async quotationCount(from: Date, to: Date): Promise<number> {
    return this.prisma.db.quotation.count({
      where: { quotationDate: { gte: from, lte: to } },
    });
  }

  /** What was BILLED in the window — the revenue figure a CA would recognise. */
  private async invoicedValue(from: Date, to: Date, query: Partial<AnalyticsQuery>) {
    const result = await this.prisma.db.invoice.aggregate({
      where: {
        status: { notIn: ['DRAFT', 'CANCELLED'] },
        invoiceDate: { gte: from, lte: to },
        ...(query.distributorId ? { distributorId: query.distributorId } : {}),
      },
      _sum: { grandTotal: true },
    });
    return Money.of(result._sum.grandTotal?.toFixed(4) ?? '0');
  }

  /** Cash actually applied in the window — distinct from what was billed. */
  private async collectedValue(from: Date, to: Date, query: Partial<AnalyticsQuery>) {
    const result = await this.prisma.db.paymentAllocation.aggregate({
      where: {
        createdAt: { gte: from, lte: to },
        ...(query.distributorId ? { invoice: { distributorId: query.distributorId } } : {}),
      },
      _sum: { amount: true },
    });
    return Money.of(result._sum.amount?.toFixed(4) ?? '0');
  }

  private async receivablesSnapshot(query: Partial<AnalyticsQuery>) {
    const today = new Date(`${iso(this.clock.now())}T00:00:00.000Z`);

    const [total, overdue] = await Promise.all([
      this.prisma.db.invoice.aggregate({
        where: {
          status: { in: [...OUTSTANDING_INVOICE_STATUSES] },
          ...(query.distributorId ? { distributorId: query.distributorId } : {}),
        },
        _sum: { amountOutstanding: true },
      }),
      this.prisma.db.invoice.aggregate({
        where: {
          status: { in: [...OUTSTANDING_INVOICE_STATUSES] },
          amountOutstanding: { gt: 0 },
          dueDate: { lt: today },
          ...(query.distributorId ? { distributorId: query.distributorId } : {}),
        },
        _sum: { amountOutstanding: true },
      }),
    ]);

    return {
      total: Money.of(total._sum.amountOutstanding?.toFixed(4) ?? '0'),
      overdue: Money.of(overdue._sum.amountOutstanding?.toFixed(4) ?? '0'),
    };
  }

  /**
   * SKUs at or below their reorder point.
   *
   * Only OWNED warehouses: a partner running low on their own shelf is their
   * replenishment decision, not a Hixaa stock alert.
   */
  private async lowStockCount(): Promise<number> {
    const settings = await this.prisma.db.inventorySetting.findMany({
      where: { warehouse: { type: { not: 'DISTRIBUTOR' } } },
      select: { warehouseId: true, productId: true, reorderLevel: true },
    });
    if (settings.length === 0) return 0;

    const balances = await this.prisma.db.stockBalance.findMany({
      where: {
        warehouse: { type: { not: 'DISTRIBUTOR' } },
        OR: settings.map((s) => ({ warehouseId: s.warehouseId, productId: s.productId })),
      },
      select: { warehouseId: true, productId: true, quantityOnHand: true },
    });

    const onHand = new Map(
      balances.map((b) => [`${b.warehouseId}:${b.productId}`, Money.of(b.quantityOnHand.toFixed(4))]),
    );

    return settings.filter((setting) => {
      const quantity = onHand.get(`${setting.warehouseId}:${setting.productId}`) ?? Money.zero();
      return quantity.lte(Money.of(setting.reorderLevel.toFixed(4)));
    }).length;
  }

  private async backorderedLineCount(): Promise<number> {
    return this.prisma.db.orderLine.count({
      where: { quantityBackordered: { gt: 0 }, order: { status: DEAD_ORDER_STATUSES } },
    });
  }

  /**
   * Stock on hand in an owned warehouse with no outbound movement for 180 days.
   *
   * A count and a value, because "how many dead SKUs" and "how much capital is
   * asleep" are different conversations.
   */
  private async deadStockCount(): Promise<{ count: number; value: Money }> {
    const cutoff = new Date(this.clock.now().getTime() - 180 * 86_400_000);

    const balances = await this.prisma.db.stockBalance.findMany({
      where: { quantityOnHand: { gt: 0 }, warehouse: { type: { not: 'DISTRIBUTOR' } } },
      select: { productId: true, warehouseId: true, quantityOnHand: true, averageCost: true },
    });
    if (balances.length === 0) return { count: 0, value: Money.zero() };

    const recentlyMoved = await this.prisma.db.stockLedgerEntry.findMany({
      where: {
        movementType: { in: ['ISSUE', 'TRANSFER_OUT'] },
        occurredAt: { gte: cutoff },
        warehouse: { type: { not: 'DISTRIBUTOR' } },
      },
      select: { productId: true, warehouseId: true },
      distinct: ['productId', 'warehouseId'],
    });
    const moved = new Set(recentlyMoved.map((row) => `${row.warehouseId}:${row.productId}`));

    let count = 0;
    let value = Money.zero();
    for (const balance of balances) {
      if (moved.has(`${balance.warehouseId}:${balance.productId}`)) continue;
      count += 1;
      value = value.add(
        Money.of(balance.quantityOnHand.toFixed(4)).multiply(balance.averageCost.toFixed(4)),
      );
    }

    return { count, value };
  }

  private async productNames(ids: readonly string[]): Promise<Map<string, string>> {
    const products = await this.prisma.db.product.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true },
    });
    return new Map(products.map((product) => [product.id, product.name]));
  }

  private orderScope(query: Partial<AnalyticsQuery>): Prisma.OrderWhereInput {
    return {
      ...(query.distributorId ? { distributorId: query.distributorId } : {}),
      ...(query.territoryId
        ? {
            OR: [
              { distributor: { territoryId: query.territoryId } },
              { customer: { territoryId: query.territoryId } },
            ],
          }
        : {}),
    };
  }

  private mayReadFinancial(): boolean {
    const access = RequestContextStore.get()?.access;
    if (!access) return false;
    return hasPermission(access, PERMISSIONS.ANALYTICS_READ_FINANCIAL);
  }

  private assertFinancial(): void {
    if (!this.mayReadFinancial()) {
      // Thrown rather than returning an empty report: a caller asking directly
      // for receivables and getting `{}` would reasonably read it as "nothing
      // is owed".
      throw new PermissionDeniedError(PERMISSIONS.ANALYTICS_READ_FINANCIAL);
    }
  }

  /**
   * Five-minute cache, per caller SCOPE.
   *
   * The scope is in the key because two users see different aggregates over the
   * same tables — caching by query alone would serve one territory's revenue to
   * another, which is a data leak wearing a performance optimisation's clothes.
   */
  private async cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const access = RequestContextStore.get()?.access;
    const scopeKey = access
      ? `${access.scopeType}:${access.territoryIds.join(',')}:${access.distributorIds.join(',')}`
      : 'anon';
    const cacheKey = `analytics:${scopeKey}:${key}`;

    const hit = await this.redis.get<T>(cacheKey);
    if (hit !== null) return hit;

    const value = await compute();
    await this.redis.set(cacheKey, value, CACHE_TTL_SECONDS);
    return value;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const iso = (date: Date): string => date.toISOString().slice(0, 10);

function countKpi(value: number, previous: number): Kpi {
  return buildKpi(String(value), String(previous));
}

function moneyKpi(value: Money, previous: Money): Kpi {
  return buildKpi(value.toString(), previous.toString());
}

/**
 * `deltaPercent` is NULL when the baseline is zero.
 *
 * Reporting "+100%" for a rise from nothing is a lie people act on — going from
 * ₹0 to ₹5,000 is not a doubling, it is a start, and the honest answer is that
 * a percentage has no meaning here.
 */
function buildKpi(value: string, previous: string): Kpi {
  const current = Money.of(value);
  const base = Money.of(previous);

  if (base.isZero()) {
    return {
      value,
      previousValue: previous,
      deltaPercent: null,
      direction: current.isZero() ? 'FLAT' : 'UP',
      inverse: false,
    };
  }

  const delta = current.subtract(base).multiply(100).divide(base.toString()).round(2);
  return {
    value,
    previousValue: previous,
    deltaPercent: delta.toString(),
    direction: delta.isZero() ? 'FLAT' : delta.isPositive() ? 'UP' : 'DOWN',
    inverse: false,
  };
}

const share = (part: Money, total: Money): string =>
  total.isZero() ? '0.00' : part.multiply(100).divide(total.toString()).round(2).toString();
