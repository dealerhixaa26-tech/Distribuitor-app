import { Money } from '@hixaa/contracts';

/**
 * GST computation. See ADR-0008.
 *
 * Deliberately a PURE module: no database, no injection, no clock. Every input
 * is passed in, so the whole tax surface is testable without a running system —
 * which matters because these numbers appear on legal documents and the tests
 * are the only thing standing between a rounding slip and a GSTR-1 mismatch.
 *
 * Two rules carry the design:
 *
 *   1. Tax is derived FORWARD from a GST-exclusive taxable value. Never backed
 *      out of an inclusive price, which leaves a residual on every line.
 *   2. A line's `totalTax` is DEFINED as the sum of its own components, and a
 *      document's total as the sum of its lines. Computing document tax
 *      independently as `sum(taxable) × rate` is the standard way this breaks:
 *      it disagrees with the sum of the rounded lines by a few paise, and the
 *      GST portal computes line-wise.
 */

/** Presentation scale. Indian invoices carry two decimals per line. */
const LINE_SCALE = 2;

export interface TaxLineInput {
  /** GST-exclusive value of the line: quantity × unit price, post-discount. */
  taxableValue: Money;
  /** Total GST percentage, e.g. `18`. Split is derived, never stored. */
  gstRate: string;
  /** Compensation cess percentage. Zero for everything Hixaa currently sells. */
  cessRate?: string;
}

export interface TaxLineResult {
  taxableValue: string;
  gstRate: string;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
  totalTax: string;
  /** taxableValue + totalTax */
  lineTotal: string;
}

export interface TaxDocumentResult {
  taxableValue: string;
  totalCgst: string;
  totalSgst: string;
  totalIgst: string;
  totalCess: string;
  totalTax: string;
  /** Sum of taxable value and tax, before whole-rupee rounding. */
  netTotal: string;
  /** The adjustment that makes the grand total a whole rupee. */
  roundOff: string;
  grandTotal: string;
}

export class GstCalculator {
  /**
   * Decides the split.
   *
   * An intra-state supply is CGST + SGST at half the rate each; an inter-state
   * supply is IGST at the full rate. The determinant is the place of supply
   * against the SUPPLIER's state — a property of the transaction, never of the
   * product. Getting this wrong produces an invoice the buyer cannot claim
   * input credit against.
   */
  static isInterState(supplierStateCode: string, placeOfSupplyStateCode: string): boolean {
    return supplierStateCode.trim() !== placeOfSupplyStateCode.trim();
  }

  /**
   * Taxes one line.
   *
   * `totalTax` is the sum of the rounded components rather than an independent
   * calculation, so `cgst + sgst + igst + cess === totalTax` holds by
   * construction rather than by luck.
   */
  static computeLine(input: TaxLineInput, interState: boolean): TaxLineResult {
    const taxable = input.taxableValue;
    const gstRate = input.gstRate;
    const cessRate = input.cessRate ?? '0';

    let cgst = Money.zero();
    let sgst = Money.zero();
    let igst = Money.zero();

    if (interState) {
      igst = taxable.percentage(gstRate).round(LINE_SCALE);
    } else {
      // Half each. Computed independently and rounded independently, because
      // that is how they are printed and how the portal reads them back. For an
      // odd-paisa taxable value the two halves can differ by one paisa, which is
      // correct and expected — CGST and SGST are separate heads of tax.
      const half = Money.of(gstRate).divide(2).toString();
      cgst = taxable.percentage(half).round(LINE_SCALE);
      sgst = taxable.percentage(half).round(LINE_SCALE);
    }

    const cess = taxable.percentage(cessRate).round(LINE_SCALE);
    const totalTax = cgst.add(sgst).add(igst).add(cess);

    return {
      taxableValue: taxable.round(LINE_SCALE).toString(),
      gstRate,
      cgst: cgst.toString(),
      sgst: sgst.toString(),
      igst: igst.toString(),
      cess: cess.toString(),
      totalTax: totalTax.toString(),
      lineTotal: taxable.round(LINE_SCALE).add(totalTax).toString(),
    };
  }

  /**
   * Aggregates taxed lines into document totals.
   *
   * Everything here is a SUM of already-rounded line values. The invoice's
   * `roundOff` absorbs the difference to a whole rupee, which is the convention
   * Indian invoices use and the reason the column exists.
   */
  static computeDocument(lines: readonly TaxLineResult[]): TaxDocumentResult {
    const taxableValue = Money.sum(lines.map((line) => line.taxableValue));
    const totalCgst = Money.sum(lines.map((line) => line.cgst));
    const totalSgst = Money.sum(lines.map((line) => line.sgst));
    const totalIgst = Money.sum(lines.map((line) => line.igst));
    const totalCess = Money.sum(lines.map((line) => line.cess));

    const totalTax = totalCgst.add(totalSgst).add(totalIgst).add(totalCess);
    const netTotal = taxableValue.add(totalTax);
    const { amount: grandTotal, roundOff } = netTotal.roundToWhole();

    return {
      taxableValue: taxableValue.toString(),
      totalCgst: totalCgst.toString(),
      totalSgst: totalSgst.toString(),
      totalIgst: totalIgst.toString(),
      totalCess: totalCess.toString(),
      totalTax: totalTax.toString(),
      netTotal: netTotal.toString(),
      roundOff: roundOff.toString(),
      grandTotal: grandTotal.toString(),
    };
  }

  /**
   * Backs a taxable value out of a tax-inclusive amount.
   *
   * Present for completeness and for the day an INCLUSIVE price list is
   * genuinely needed (ADR-0008 rejects one today). NOT used by the pricing
   * engine: Hixaa quotes ex-GST, and routing through this would introduce the
   * per-line residual the exclusive basis exists to avoid.
   */
  static taxableFromInclusive(inclusiveAmount: Money, gstRate: string): Money {
    const divisor = Money.of(100).add(gstRate).toString();
    return inclusiveAmount.multiply(100).divide(divisor);
  }
}
