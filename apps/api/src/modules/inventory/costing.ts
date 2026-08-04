import { Money } from '@hixaa/contracts';

/**
 * Moving weighted-average costing. See ADR-0010.
 *
 * A PURE module, like `gst-calculator.ts` and `discount-resolver.ts`: values in,
 * value out, no database and no injection. Inventory valuation is a number an
 * auditor will ask about years from now, so the arithmetic that produces it is
 * kept where it can be tested exhaustively without a running system.
 */

export interface AverageCostInput {
  /** Quantity on hand BEFORE this movement. */
  onHandBefore: Money;
  /** The average in force before this movement. */
  currentAverage: Money;
  /** Signed quantity of the movement. */
  movementQuantity: Money;
  /** Cost per unit paid on this receipt. Null means "no cost stated". */
  movementUnitCost: string | null;
}

/**
 * The new average after a movement.
 *
 *   newAverage = (onHand × currentAverage + qtyIn × costIn) ÷ (onHand + qtyIn)
 *
 * Three rules, each of which exists because getting it wrong is quiet:
 *
 *   • **Outbound movements never change the average.** Issuing stock does not
 *     alter what the remainder cost. This is the defining property of the
 *     method, and the reason COGS is stable.
 *   • **A receipt with no stated cost keeps the current average**, never zero.
 *     A zero-cost receipt drags the average down and understates inventory —
 *     invisible until a year-end valuation, and painful to unwind then.
 *   • **A receipt into an empty bin adopts the receipt's cost.** Averaging
 *     against an on-hand of zero is a division by zero dressed up as a formula.
 */
export function nextAverageCost(input: AverageCostInput): Money {
  const inbound = input.movementQuantity.isPositive();
  if (!inbound) return input.currentAverage;
  if (input.movementUnitCost === null) return input.currentAverage;

  const incomingCost = Money.of(input.movementUnitCost);
  const totalQty = input.onHandBefore.add(input.movementQuantity);

  if (input.onHandBefore.lte(Money.zero()) || totalQty.isZero()) return incomingCost;

  const existingValue = input.onHandBefore.multiply(input.currentAverage.toString());
  const incomingValue = input.movementQuantity.multiply(incomingCost.toString());

  // Rounded to the storage scale so the stored average and a recomputation
  // from the same inputs agree exactly.
  return existingValue.add(incomingValue).divide(totalQty.toString()).round(4);
}

/**
 * The cost a movement is RECORDED at, which is not always the new average.
 *
 * A receipt is recorded at what was actually paid. An issue is recorded at the
 * average prevailing *before* it — which is what makes the ledger a faithful
 * record of cost of goods sold rather than a restatement.
 */
export function ledgerUnitCost(input: {
  inbound: boolean;
  currentAverage: Money;
  movementUnitCost: string | null;
}): Money {
  if (input.inbound && input.movementUnitCost !== null) return Money.of(input.movementUnitCost);
  return input.currentAverage;
}

/** Value of a holding: quantity × average cost. */
export function stockValue(quantityOnHand: Money, averageCost: Money): Money {
  return quantityOnHand.multiply(averageCost.toString()).round(4);
}
