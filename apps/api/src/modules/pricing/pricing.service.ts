import { Injectable } from '@nestjs/common';
import {
  HIXAA_STATE_CODE,
  Money,
  stateCodeFromGstin,
  type DiscountCandidate,
  type QuoteLineRequest,
  type QuoteLineResult,
  type QuoteRequest,
  type QuoteResult,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import {
  NotFoundError,
  PriceNotFoundError,
  ProductNotAuthorizedError,
  ConflictError,
} from '../../common/errors/domain.error';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { applyDiscount, selectDiscount, type DiscountRuleInput } from './discount-resolver';
import { GstCalculator, type TaxLineResult } from './gst-calculator';

/**
 * The pricing engine. See ADR-0007.
 *
 * This is the ONLY place in the system that answers "what does this cost?".
 * Quotations (Phase 7), orders (Phase 7), and invoices (Phase 8) all call
 * `quote()` rather than reading `PriceListItem.price` themselves. That is a
 * convention the compiler cannot enforce, so it is stated here, in the ADR, and
 * in the module README: a quote and the invoice it becomes must never disagree,
 * and the only way to guarantee that is one implementation.
 *
 * `quote()` is a pure read. It writes nothing.
 */

/** The pipeline, per line: list → slab → one discount → override → tax. */
@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PricingService.name);
  }

  async quote(request: QuoteRequest, actorId?: string): Promise<QuoteResult> {
    const asOf = request.asOf ?? this.toDateOnly(this.clock.now());
    const asOfDate = new Date(`${asOf}T00:00:00.000Z`);

    const supplierStateCode = await this.supplierStateCode();
    const distributor = request.distributorId
      ? await this.loadDistributor(request.distributorId)
      : null;

    const placeOfSupplyStateCode =
      request.placeOfSupplyStateCode ??
      (distributor?.gstin ? stateCodeFromGstin(distributor.gstin) : supplierStateCode);

    const interState = GstCalculator.isInterState(supplierStateCode, placeOfSupplyStateCode);

    // The caller's discount ceiling, resolved once rather than per line.
    const maxDiscountPercent = actorId ? await this.callerDiscountCeiling(actorId) : null;

    // Which products this partner may buy. An EMPTY authorized catalog means
    // unrestricted rather than "nothing": a distributor onboarded before the
    // catalog existed must not become unable to order anything.
    const authorized = distributor ? await this.authorizedCatalog(distributor.id) : null;

    const lines: QuoteLineResult[] = [];
    const taxLines: TaxLineResult[] = [];

    for (const line of request.lines) {
      const resolved = await this.resolveLine({
        line,
        asOf,
        asOfDate,
        distributor,
        authorized,
        explicitPriceListId: request.priceListId,
        interState,
        maxDiscountPercent,
        includeTrace: request.includeTrace,
      });
      lines.push(resolved.line);
      taxLines.push(resolved.tax);
    }

    const totals = GstCalculator.computeDocument(taxLines);

    const subtotal = Money.sum(
      lines.map((line) => Money.of(line.listUnitPrice).multiply(line.quantity).toString()),
    );
    const totalDiscount = Money.sum(lines.map((line) => line.discountAmount));

    const approvalReasons = [
      ...new Set(lines.flatMap((line) => line.approvalReasons)),
    ];

    return {
      asOf,
      currency: 'INR',
      placeOfSupplyStateCode,
      supplierStateCode,
      isInterState: interState,
      lines,
      subtotal: subtotal.toString(),
      totalDiscount: totalDiscount.toString(),
      taxableValue: totals.taxableValue,
      totalCgst: totals.totalCgst,
      totalSgst: totals.totalSgst,
      totalIgst: totals.totalIgst,
      totalCess: totals.totalCess,
      totalTax: totals.totalTax,
      roundOff: totals.roundOff,
      grandTotal: totals.grandTotal,
      requiresApproval: lines.some((line) => line.requiresApproval),
      approvalReasons,
    };
  }

  // ── The pipeline ──────────────────────────────────────────────────────────

  private async resolveLine(input: {
    line: QuoteLineRequest;
    asOf: string;
    asOfDate: Date;
    distributor: DistributorContext | null;
    authorized: Map<string, string | null> | null;
    explicitPriceListId?: string;
    interState: boolean;
    maxDiscountPercent: string | null;
    includeTrace: boolean;
  }): Promise<{ line: QuoteLineResult; tax: TaxLineResult }> {
    const { line, asOfDate, distributor, authorized, interState } = input;

    const product = await this.prisma.db.product.findFirst({
      where: { id: line.productId },
      select: {
        id: true,
        sku: true,
        name: true,
        status: true,
        isSellable: true,
        hsnCode: true,
        sacCode: true,
        gstRate: true,
        categoryId: true,
        category: { select: { path: true } },
      },
    });
    if (!product) throw new NotFoundError('Product', line.productId);

    if (!product.isSellable) {
      throw new ConflictError(`"${product.sku}" is not marked sellable and cannot be quoted.`);
    }
    if (product.status === 'DRAFT' || product.status === 'ARCHIVED') {
      throw new ConflictError(
        `"${product.sku}" is ${product.status} and cannot be quoted. Only ACTIVE and DISCONTINUED products may be sold.`,
      );
    }

    // Authorized catalog — the seam Phase 5 left open, now load-bearing.
    if (authorized && authorized.size > 0 && !authorized.has(product.id)) {
      throw new ProductNotAuthorizedError(product.sku, distributor?.code ?? 'this distributor');
    }

    // ── 1. Price list ──────────────────────────────────────────────────────
    const customPriceListId = authorized?.get(product.id) ?? null;
    const { priceList, reason } = await this.resolvePriceList({
      explicitId: input.explicitPriceListId,
      customId: customPriceListId,
      distributorListId: distributor?.priceListId ?? null,
      asOfDate,
    });

    // ── 2. Volume slab ─────────────────────────────────────────────────────
    const slab = await this.resolveSlab(priceList.id, product.id, line.variantId, line.quantity);
    if (!slab) {
      throw new PriceNotFoundError(product.sku, priceList.code, line.quantity);
    }

    const listUnitPrice = Money.of(slab.price.toFixed(4));
    const lineGross = listUnitPrice.multiply(line.quantity);

    // ── 3. Discount rules — one winner, never stacked ──────────────────────
    const candidates: DiscountCandidate[] = [];
    let discountedUnitPrice = listUnitPrice;

    if (!line.skipDiscounts) {
      const applicable = await this.gatherDiscountRules({
        asOfDate,
        productId: product.id,
        categoryPath: product.category?.path ?? null,
        distributorId: distributor?.id ?? null,
        priceListId: priceList.id,
      });

      const selection = selectDiscount(applicable, line.quantity, lineGross);
      candidates.push(...selection.candidates);
      if (selection.winner) {
        discountedUnitPrice = applyDiscount(selection.winner, listUnitPrice, line.quantity);
      }
    }

    // ── 4. Manual override — the situational lever ─────────────────────────
    const approvalReasons: string[] = [];
    let unitPrice = discountedUnitPrice;
    let isOverridden = false;

    if (line.override) {
      unitPrice = Money.of(line.override.unitPrice);
      isOverridden = true;

      if (slab.minPrice && unitPrice.lt(slab.minPrice.toFixed(4))) {
        approvalReasons.push(
          `${product.sku}: ${unitPrice.toDisplayString()} is below the price floor of ${Money.of(slab.minPrice.toFixed(4)).toDisplayString()}`,
        );
      }
    }

    const effectiveDiscountPercent = listUnitPrice.isZero()
      ? Money.zero()
      : listUnitPrice.subtract(unitPrice).divide(listUnitPrice.toString()).multiply(100);

    if (
      isOverridden &&
      input.maxDiscountPercent !== null &&
      effectiveDiscountPercent.gt(input.maxDiscountPercent)
    ) {
      approvalReasons.push(
        `${product.sku}: ${effectiveDiscountPercent.round(2).toDisplayString()}% discount exceeds your ceiling of ${Money.of(input.maxDiscountPercent).toDisplayString()}%`,
      );
    }

    const taxableValue = unitPrice.multiply(line.quantity);
    const discountAmount = lineGross.subtract(taxableValue);

    // ── 5. Tax ─────────────────────────────────────────────────────────────
    const hsnSacCode = product.sacCode ?? product.hsnCode;
    const taxRate = hsnSacCode ? await this.resolveTaxRate(hsnSacCode, asOfDate) : null;

    // TaxRate is authoritative (ADR-0008). When no row covers this code we fall
    // back to the product's snapshot rather than refusing, so a newly added
    // product is still quotable — but the trace records that we did, and Phase 8
    // invoicing must refuse to ISSUE against a PRODUCT_SNAPSHOT source. A quote
    // is a conversation; an invoice is a legal document.
    const gstRate = taxRate ? taxRate.gstRate.toFixed(2) : product.gstRate.toFixed(2);
    const cessRate = taxRate ? taxRate.cessRate.toFixed(2) : '0';

    const tax = GstCalculator.computeLine({ taxableValue, gstRate, cessRate }, interState);

    const result: QuoteLineResult = {
      productId: product.id,
      variantId: line.variantId ?? null,
      sku: product.sku,
      name: product.name,
      quantity: Money.of(line.quantity).toString(),
      listUnitPrice: listUnitPrice.toString(),
      unitPrice: unitPrice.toString(),
      discountAmount: discountAmount.toString(),
      discountPercent: effectiveDiscountPercent.round(4).toString(),
      taxableValue: tax.taxableValue,
      hsnSacCode,
      gstRate,
      cgst: tax.cgst,
      sgst: tax.sgst,
      igst: tax.igst,
      cess: tax.cess,
      totalTax: tax.totalTax,
      lineTotal: tax.lineTotal,
      isOverridden,
      overrideReason: line.override?.reason ?? null,
      effectiveDiscountPercent: effectiveDiscountPercent.round(4).toString(),
      requiresApproval: approvalReasons.length > 0,
      approvalReasons,
      trace: input.includeTrace
        ? {
            priceListId: priceList.id,
            priceListCode: priceList.code,
            priceListReason: reason,
            matchedSlabMinQty: slab.minQty.toFixed(4),
            listPrice: listUnitPrice.toString(),
            discountCandidates: candidates,
            taxRateId: taxRate?.id ?? null,
            taxRateSource: taxRate ? 'TAX_RATE_TABLE' : 'PRODUCT_SNAPSHOT',
          }
        : null,
    };

    return { line: result, tax };
  }

  // ── Step 1: which price list ──────────────────────────────────────────────

  private async resolvePriceList(input: {
    explicitId?: string;
    customId: string | null;
    distributorListId: string | null;
    asOfDate: Date;
  }): Promise<{ priceList: PriceListRow; reason: PriceListReason }> {
    const attempts: Array<{ id: string | null; reason: PriceListReason }> = [
      { id: input.explicitId ?? null, reason: 'EXPLICIT' },
      { id: input.customId, reason: 'DISTRIBUTOR_CUSTOM' },
      { id: input.distributorListId, reason: 'DISTRIBUTOR_ASSIGNED' },
    ];

    for (const attempt of attempts) {
      if (!attempt.id) continue;
      const found = await this.prisma.db.priceList.findFirst({
        where: { id: attempt.id },
        select: PRICE_LIST_SELECT,
      });
      if (!found) throw new NotFoundError('PriceList', attempt.id);
      this.assertUsable(found, input.asOfDate);
      return { priceList: found, reason: attempt.reason };
    }

    const fallback = await this.prisma.db.priceList.findFirst({
      where: { isDefault: true },
      select: PRICE_LIST_SELECT,
    });
    if (!fallback) {
      throw new ConflictError(
        'No price list applies and no default price list is configured. ' +
          'Mark one price list as the default before quoting.',
      );
    }
    this.assertUsable(fallback, input.asOfDate);
    return { priceList: fallback, reason: 'DEFAULT' };
  }

  private assertUsable(priceList: PriceListRow, asOfDate: Date): void {
    if (priceList.status !== 'ACTIVE') {
      throw new ConflictError(
        `Price list ${priceList.code} is ${priceList.status}. Only an ACTIVE list can be quoted from.`,
      );
    }
    if (priceList.validFrom > asOfDate) {
      throw new ConflictError(
        `Price list ${priceList.code} does not take effect until ${this.toDateOnly(priceList.validFrom)}.`,
      );
    }
    if (priceList.validTo && priceList.validTo < asOfDate) {
      throw new ConflictError(
        `Price list ${priceList.code} expired on ${this.toDateOnly(priceList.validTo)}.`,
      );
    }
  }

  // ── Step 2: which volume slab ─────────────────────────────────────────────

  /**
   * The highest `minQty` that does not exceed the ordered quantity.
   *
   * A variant-specific row wins over the product-level row: configuring a
   * variant is a deliberate act, and its price should not be silently
   * overridden by the generic one.
   */
  private async resolveSlab(
    priceListId: string,
    productId: string,
    variantId: string | undefined,
    quantity: string,
  ): Promise<SlabRow | null> {
    if (variantId) {
      const variantSlab = await this.prisma.db.priceListItem.findFirst({
        where: { priceListId, productId, variantId, minQty: { lte: quantity } },
        orderBy: { minQty: 'desc' },
        select: SLAB_SELECT,
      });
      if (variantSlab) return variantSlab;
    }

    return this.prisma.db.priceListItem.findFirst({
      where: { priceListId, productId, variantId: null, minQty: { lte: quantity } },
      orderBy: { minQty: 'desc' },
      select: SLAB_SELECT,
    });
  }

  // ── Step 3: discounts ─────────────────────────────────────────────────────

  private async gatherDiscountRules(input: {
    asOfDate: Date;
    productId: string;
    categoryPath: string | null;
    distributorId: string | null;
    priceListId: string;
  }): Promise<DiscountRuleInput[]> {
    // A discount on a parent category applies to everything beneath it, so the
    // whole ancestor chain is a candidate target — that is the point of having
    // a tree rather than a flat list.
    const categoryIds = input.categoryPath
      ? input.categoryPath.split('.').filter(Boolean)
      : [];

    const targets: Prisma.DiscountRuleWhereInput[] = [
      { scope: 'GLOBAL' },
      { scope: 'PRODUCT', targetId: input.productId },
      { scope: 'PRICE_LIST', targetId: input.priceListId },
    ];
    if (categoryIds.length > 0) {
      targets.push({ scope: 'CATEGORY', targetId: { in: categoryIds } });
    }
    if (input.distributorId) {
      targets.push({ scope: 'DISTRIBUTOR', targetId: input.distributorId });
    }

    const rows = await this.prisma.db.discountRule.findMany({
      where: {
        isActive: true,
        validFrom: { lte: input.asOfDate },
        OR: targets,
        AND: [{ OR: [{ validTo: null }, { validTo: { gte: input.asOfDate } }] }],
      },
      select: RULE_SELECT,
    });

    // Decimal → string at the boundary, so `discount-resolver` stays a pure
    // module with no Prisma dependency and can be tested without a database.
    return rows.map<DiscountRuleInput>((rule) => ({
      id: rule.id,
      code: rule.code,
      name: rule.name,
      scope: rule.scope,
      type: rule.type,
      value: rule.value.toFixed(4),
      minQty: rule.minQty ? rule.minQty.toFixed(4) : null,
      minAmount: rule.minAmount ? rule.minAmount.toFixed(4) : null,
      maxDiscountAmount: rule.maxDiscountAmount ? rule.maxDiscountAmount.toFixed(4) : null,
      priority: rule.priority,
    }));
  }

  // ── Step 5: the rate in force on the day ──────────────────────────────────

  private async resolveTaxRate(hsnSacCode: string, asOfDate: Date): Promise<TaxRateRow | null> {
    return this.prisma.db.taxRate.findFirst({
      where: {
        hsnSacCode,
        effectiveFrom: { lte: asOfDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOfDate } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      select: { id: true, gstRate: true, cessRate: true },
    });
  }

  // ── Context loading ───────────────────────────────────────────────────────

  private async loadDistributor(id: string): Promise<DistributorContext> {
    // Goes through `this.prisma.db`, so the scope extension applies: a
    // territory-scoped caller quoting for a distributor outside their subtree
    // gets a 404 here rather than a price.
    const distributor = await this.prisma.db.distributor.findFirst({
      where: { id },
      select: { id: true, code: true, gstin: true, priceListId: true, status: true },
    });
    if (!distributor) throw new NotFoundError('Distributor', id);
    return distributor;
  }

  /** Product id → its custom price list id (or null). Empty means unrestricted. */
  private async authorizedCatalog(distributorId: string): Promise<Map<string, string | null>> {
    const rows = await this.prisma.db.distributorProduct.findMany({
      where: { distributorId, isActive: true },
      select: { productId: true, customPriceListId: true },
    });
    return new Map(rows.map((row) => [row.productId, row.customPriceListId]));
  }

  /**
   * The caller's discount ceiling — the most permissive of their roles.
   *
   * A null ceiling means unlimited, which is why the reduction starts at null
   * and any null role short-circuits: holding one unlimited role must not be
   * capped by also holding a limited one.
   */
  private async callerDiscountCeiling(userId: string): Promise<string | null> {
    const roles = await this.prisma.db.userRole.findMany({
      where: { userId },
      select: { role: { select: { maxDiscountPercent: true } } },
    });
    if (roles.length === 0) return null;

    let ceiling: Money | null = null;
    for (const assignment of roles) {
      const limit = assignment.role.maxDiscountPercent;
      if (limit === null) return null;
      const value = Money.of(limit.toFixed(4));
      ceiling = ceiling === null ? value : Money.max(ceiling, value);
    }
    return ceiling?.toString() ?? null;
  }

  private async supplierStateCode(): Promise<string> {
    const statutory = await this.settings.get<{ stateCode?: string }>('company', 'statutory');
    return statutory?.stateCode?.trim() || HIXAA_STATE_CODE;
  }

  private toDateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}

// ── Row shapes, kept next to the queries that produce them ──────────────────

const PRICE_LIST_SELECT = {
  id: true,
  code: true,
  status: true,
  validFrom: true,
  validTo: true,
} satisfies Prisma.PriceListSelect;

const SLAB_SELECT = {
  id: true,
  minQty: true,
  price: true,
  minPrice: true,
} satisfies Prisma.PriceListItemSelect;

const RULE_SELECT = {
  id: true,
  code: true,
  name: true,
  scope: true,
  type: true,
  value: true,
  minQty: true,
  minAmount: true,
  maxDiscountAmount: true,
  priority: true,
} satisfies Prisma.DiscountRuleSelect;

/** Why a particular price list won, surfaced in the trace. */
type PriceListReason = NonNullable<QuoteLineResult['trace']>['priceListReason'];

type PriceListRow = Prisma.PriceListGetPayload<{ select: typeof PRICE_LIST_SELECT }>;
type SlabRow = Prisma.PriceListItemGetPayload<{ select: typeof SLAB_SELECT }>;
type TaxRateRow = { id: string; gstRate: Prisma.Decimal; cessRate: Prisma.Decimal };

interface DistributorContext {
  id: string;
  code: string;
  gstin: string | null;
  priceListId: string | null;
  status: string;
}
