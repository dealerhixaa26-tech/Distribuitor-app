import { Injectable } from '@nestjs/common';
import { Money, type QuoteLineResult, type QuoteResult, type SalesLineInput } from '@hixaa/contracts';
import { PinoLogger } from 'nestjs-pino';
import { NotFoundError } from '../../common/errors/domain.error';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { PricingService } from '../pricing/pricing.service';

/**
 * Turns a caller's line inputs into priced, snapshot-ready line data.
 *
 * ── Why this exists as a separate helper ───────────────────────────────────
 * Quotations and orders need identical pricing behaviour: same engine, same
 * snapshot fields, same totals. Duplicating it would guarantee they drift, and
 * the drift would surface as a quotation and its converted order disagreeing on
 * the total — which is the precise failure ADR-0007 and ADR-0011 exist to
 * prevent.
 *
 * This helper does NOT price anything itself. It calls
 * `PricingService.quote()` (the one pricing entry point) and maps the result
 * onto the columns a line stores. If you find yourself computing a price here,
 * that is the bug.
 */
@Injectable()
export class SalesPricingHelper {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SalesPricingHelper.name);
  }

  /**
   * Prices a set of lines and returns both the document totals and the
   * per-line snapshot rows.
   *
   * `asOf` is passed explicitly so re-pricing a quotation on its original date
   * reproduces the original figures — the engine is date-effective throughout
   * (price lists, discount rules, tax rates), and defaulting to "today" would
   * make a re-price silently a different question.
   */
  async priceLines(input: {
    lines: readonly SalesLineInput[];
    distributorId?: string | null;
    priceListId?: string | null;
    placeOfSupplyStateCode?: string | null;
    asOf?: string;
    actorId: string;
  }): Promise<PricedDocument> {
    const quote = await this.pricing.quote(
      {
        ...(input.distributorId ? { distributorId: input.distributorId } : {}),
        ...(input.priceListId ? { priceListId: input.priceListId } : {}),
        ...(input.placeOfSupplyStateCode
          ? { placeOfSupplyStateCode: input.placeOfSupplyStateCode }
          : {}),
        ...(input.asOf ? { asOf: input.asOf } : {}),
        includeTrace: true,
        lines: input.lines.map((line) => ({
          productId: line.productId,
          ...(line.variantId ? { variantId: line.variantId } : {}),
          quantity: line.quantity,
          ...(line.override ? { override: line.override } : {}),
          skipDiscounts: false,
        })),
      },
      input.actorId,
    );

    // Product metadata the engine does not return but a line must snapshot:
    // the UOM code and the revision the price was quoted against (ADR-0011).
    const productIds = [...new Set(input.lines.map((line) => line.productId))];
    const products = await this.prisma.db.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, revision: true, uom: { select: { code: true } } },
    });
    if (products.length !== productIds.length) {
      const known = new Set(products.map((p) => p.id));
      throw new NotFoundError('Product', productIds.filter((id) => !known.has(id)).join(', '));
    }
    const meta = new Map(products.map((p) => [p.id, p]));

    const lines = quote.lines.map((line, index) => {
      const source = input.lines[index];
      const product = meta.get(line.productId);
      return this.toSnapshot(line, index + 1, {
        uomCode: product?.uom?.code ?? null,
        productRevision: product?.revision ?? 1,
        notes: source?.notes ?? null,
        discountRuleId: appliedRuleId(line),
      });
    });

    return { quote, lines, totals: toTotals(quote) };
  }

  /**
   * Maps one engine result onto the columns a line stores.
   *
   * Every value here is copied, not referenced. That is the whole of ADR-0011:
   * a price list can be archived, a discount rule deleted, a GST rate
   * superseded, and this row still says what was agreed.
   */
  private toSnapshot(
    line: QuoteLineResult,
    lineNumber: number,
    extra: {
      uomCode: string | null;
      productRevision: number;
      notes: string | null;
      discountRuleId: string | null;
    },
  ): PricedLine {
    return {
      lineNumber,
      productId: line.productId,
      variantId: line.variantId,
      sku: line.sku,
      description: line.name,
      productRevision: extra.productRevision,
      quantity: line.quantity,
      uomCode: extra.uomCode,
      unitListPrice: line.listUnitPrice,
      unitPrice: line.unitPrice,
      discountAmount: line.discountAmount,
      discountPercent: line.effectiveDiscountPercent,
      discountRuleId: extra.discountRuleId,
      overrideReason: line.overrideReason,
      taxableValue: line.taxableValue,
      hsnSacCode: line.hsnSacCode,
      gstRate: line.gstRate,
      cgst: line.cgst,
      sgst: line.sgst,
      igst: line.igst,
      cess: line.cess,
      totalTax: line.totalTax,
      lineTotal: line.lineTotal,
      notes: extra.notes,
      requiresApproval: line.requiresApproval,
      approvalReasons: line.approvalReasons,
    };
  }

  /**
   * The highest effective discount on any line, as a percentage.
   *
   * This is what an approval ceiling is compared against — the worst line, not
   * the document average. Averaging would let a 40% giveaway on one item hide
   * behind full-price lines, which is exactly the case a ceiling exists to catch.
   */
  static maxDiscountPercent(lines: readonly PricedLine[]): Money {
    return lines.reduce(
      (worst, line) => Money.max(worst, Money.of(line.discountPercent)),
      Money.zero(),
    );
  }
}

/** The discount rule that actually applied, if any — for line provenance. */
function appliedRuleId(line: QuoteLineResult): string | null {
  return line.trace?.discountCandidates.find((candidate) => candidate.applied)?.ruleId ?? null;
}

function toTotals(quote: QuoteResult) {
  return {
    subtotal: quote.subtotal,
    totalDiscount: quote.totalDiscount,
    taxableValue: quote.taxableValue,
    totalCgst: quote.totalCgst,
    totalSgst: quote.totalSgst,
    totalIgst: quote.totalIgst,
    totalTax: quote.totalTax,
    roundOff: quote.roundOff,
    grandTotal: quote.grandTotal,
  };
}

export interface PricedLine {
  lineNumber: number;
  productId: string;
  variantId: string | null;
  sku: string;
  description: string;
  productRevision: number;
  quantity: string;
  uomCode: string | null;
  unitListPrice: string;
  unitPrice: string;
  discountAmount: string;
  discountPercent: string;
  discountRuleId: string | null;
  overrideReason: string | null;
  taxableValue: string;
  hsnSacCode: string | null;
  gstRate: string;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
  totalTax: string;
  lineTotal: string;
  notes: string | null;
  requiresApproval: boolean;
  approvalReasons: string[];
}

export interface PricedDocument {
  quote: QuoteResult;
  lines: PricedLine[];
  totals: {
    subtotal: string;
    totalDiscount: string;
    taxableValue: string;
    totalCgst: string;
    totalSgst: string;
    totalIgst: string;
    totalTax: string;
    roundOff: string;
    grandTotal: string;
  };
}
