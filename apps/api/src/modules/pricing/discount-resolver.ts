import {
  DISCOUNT_SCOPE_SPECIFICITY,
  Money,
  type DiscountCandidate,
  type DiscountScope,
  type DiscountType,
} from '@hixaa/contracts';

/**
 * Discount selection and application. See ADR-0007 §3.
 *
 * A PURE module, like `gst-calculator.ts`: rules come in as plain values, a
 * decision goes out. No database, no injection. Discount resolution is the part
 * of pricing most likely to be argued about after the fact — "why did this
 * customer get 15%?" — so it is the part that most needs to be testable in
 * isolation and to explain itself.
 */

/** A candidate rule, flattened out of its Prisma row. */
export interface DiscountRuleInput {
  id: string;
  code: string;
  name: string;
  scope: DiscountScope;
  type: DiscountType;
  /** Percentage (0–100) for PERCENT, an absolute per-unit amount for FLAT. */
  value: string;
  minQty: string | null;
  minAmount: string | null;
  maxDiscountAmount: string | null;
  /** Lower wins. */
  priority: number;
}

export interface DiscountSelection {
  winner: DiscountRuleInput | null;
  /** Every rule considered, with the winner marked and the rest explained. */
  candidates: DiscountCandidate[];
}

/**
 * Picks the single winning rule and records why every other lost.
 *
 * Rules do NOT stack. Two 15% rules that happen to both match is how a 30%
 * discount reaches a customer nobody approved — invisible until a quarter-end
 * margin review, and untraceable by then.
 *
 * Ordering: `priority` ascending, then scope specificity (PRODUCT before
 * CATEGORY before DISTRIBUTOR before PRICE_LIST before GLOBAL), then `code`.
 * The final tie-break on code is not cosmetic: without it two equally-ranked
 * rules would resolve by whatever order the database returned, so the same
 * quote could price differently on two runs.
 */
export function selectDiscount(
  rules: readonly DiscountRuleInput[],
  quantity: string,
  lineGross: Money,
): DiscountSelection {
  const candidates: DiscountCandidate[] = [];
  const eligible: DiscountRuleInput[] = [];

  for (const rule of rules) {
    const candidate: DiscountCandidate = {
      ruleId: rule.id,
      code: rule.code,
      name: rule.name,
      scope: rule.scope,
      type: rule.type,
      value: rule.value,
      priority: rule.priority,
      applied: false,
    };

    if (rule.minQty && Money.of(quantity).lt(rule.minQty)) {
      candidate.rejectedBecause = `quantity ${quantity} is below the rule's minimum of ${Money.of(rule.minQty).toDisplayString()}`;
      candidates.push(candidate);
      continue;
    }

    if (rule.minAmount && lineGross.lt(rule.minAmount)) {
      candidate.rejectedBecause = `line value ${lineGross.toDisplayString()} is below the rule's minimum of ${Money.of(rule.minAmount).toDisplayString()}`;
      candidates.push(candidate);
      continue;
    }

    eligible.push(rule);
    candidates.push(candidate);
  }

  if (eligible.length === 0) return { winner: null, candidates };

  const ranked = [...eligible].sort(
    (a, b) =>
      a.priority - b.priority ||
      DISCOUNT_SCOPE_SPECIFICITY[a.scope] - DISCOUNT_SCOPE_SPECIFICITY[b.scope] ||
      a.code.localeCompare(b.code),
  );

  const winner = ranked[0];
  if (!winner) return { winner: null, candidates };

  for (const candidate of candidates) {
    if (candidate.rejectedBecause) continue;
    if (candidate.ruleId === winner.id) {
      candidate.applied = true;
    } else {
      candidate.rejectedBecause = `outranked by ${winner.code} (priority ${winner.priority}, scope ${winner.scope})`;
    }
  }

  return { winner, candidates };
}

/**
 * Applies a rule to a unit price, returning the discounted unit price.
 *
 * A PERCENT rule reduces the unit price by a percentage. A FLAT rule takes an
 * absolute amount off each UNIT — chosen over "off the line" because a price
 * list expresses per-unit money everywhere else, and mixing the two conventions
 * is how a rule comes to mean one thing to its author and another to the engine.
 *
 * `maxDiscountAmount` caps the LINE's total give-away, which is why quantity is
 * needed here: a 10% rule on a ₹24-lakh bench is capped very differently at
 * quantity 1 than at quantity 10.
 */
export function applyDiscount(
  rule: DiscountRuleInput,
  listUnitPrice: Money,
  quantity: string,
): Money {
  let discounted =
    rule.type === 'PERCENT'
      ? listUnitPrice.subtract(listUnitPrice.percentage(rule.value))
      : listUnitPrice.subtract(rule.value);

  // A flat discount larger than the price itself must not invert the line into
  // the company paying the customer.
  if (discounted.isNegative()) discounted = Money.zero();

  if (rule.maxDiscountAmount) {
    const cap = Money.of(rule.maxDiscountAmount);
    const lineDiscount = listUnitPrice.subtract(discounted).multiply(quantity);
    if (lineDiscount.gt(cap)) {
      discounted = listUnitPrice.subtract(cap.divide(quantity));
    }
  }

  return discounted;
}
