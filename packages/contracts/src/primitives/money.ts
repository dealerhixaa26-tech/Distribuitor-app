import Decimal from 'decimal.js';
import { z } from 'zod';

/**
 * Money — exact decimal arithmetic for currency. See ADR-0004.
 *
 * Rules this type exists to enforce:
 *   1. No `float`/`number` ever holds a monetary value. `0.1 + 0.2 !== 0.3`.
 *   2. Money crosses the wire as a STRING. JSON numbers are IEEE-754 doubles and
 *      silently alter large invoice amounts.
 *   3. Rounding is explicit and half-up, matching Indian invoicing convention.
 *
 * Storage scale is 4 decimal places: per-unit prices and tax intermediates in
 * industrial quotations routinely need more precision than the 2 places a final
 * amount is presented with.
 */

/** Decimal places retained in storage and on the wire. */
export const MONEY_SCALE = 4;
/** Decimal places used when presenting an amount to a human. */
export const MONEY_DISPLAY_SCALE = 2;

// ROUND_HALF_UP: 0.5 always rounds away from zero, which is what Indian
// invoicing expects. Decimal.js defaults to ROUND_HALF_UP already, but relying
// on a library default for a legal document is not a risk worth taking.
const MoneyDecimal = Decimal.clone({
  precision: 34,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

export type MoneyInput = string | number | Money | Decimal;

export class Money {
  private readonly value: Decimal;

  private constructor(value: Decimal) {
    this.value = value;
  }

  // ── Construction ──────────────────────────────────────────────────────────

  static of(input: MoneyInput): Money {
    if (input instanceof Money) return input;

    if (typeof input === 'number') {
      // A number literal in source is fine (Money.of(0)); a number arriving from
      // JSON has already lost precision before we ever see it. Reject the unsafe
      // ones loudly rather than propagating a silently wrong amount.
      if (!Number.isFinite(input)) {
        throw new TypeError(`Money.of received a non-finite number: ${input}`);
      }
      if (!Number.isSafeInteger(input) && !Number.isInteger(input)) {
        // Fractional numbers are the dangerous case — route them through their
        // string form so the caller's literal is preserved exactly.
        return new Money(new MoneyDecimal(input.toString()));
      }
    }

    try {
      return new Money(new MoneyDecimal(input as Decimal.Value));
    } catch {
      throw new TypeError(`Money.of received an unparseable value: ${String(input)}`);
    }
  }

  static zero(): Money {
    return new Money(new MoneyDecimal(0));
  }

  /** Parses an untrusted string, returning null instead of throwing. */
  static tryParse(input: unknown): Money | null {
    if (typeof input !== 'string' && typeof input !== 'number') return null;
    try {
      return Money.of(input);
    } catch {
      return null;
    }
  }

  static sum(items: readonly MoneyInput[]): Money {
    return items.reduce<Money>((acc, item) => acc.add(item), Money.zero());
  }

  static min(a: MoneyInput, b: MoneyInput): Money {
    const left = Money.of(a);
    const right = Money.of(b);
    return left.lte(right) ? left : right;
  }

  static max(a: MoneyInput, b: MoneyInput): Money {
    const left = Money.of(a);
    const right = Money.of(b);
    return left.gte(right) ? left : right;
  }

  // ── Arithmetic ────────────────────────────────────────────────────────────

  add(other: MoneyInput): Money {
    return new Money(this.value.plus(Money.of(other).value));
  }

  subtract(other: MoneyInput): Money {
    return new Money(this.value.minus(Money.of(other).value));
  }

  /** Multiply by a scalar — a quantity or a factor, never another Money. */
  multiply(factor: string | number): Money {
    return new Money(this.value.times(new MoneyDecimal(factor)));
  }

  divide(divisor: string | number): Money {
    const d = new MoneyDecimal(divisor);
    if (d.isZero()) throw new RangeError('Money.divide by zero');
    return new Money(this.value.dividedBy(d));
  }

  /** `percentage(18)` → 18% of this amount. */
  percentage(percent: string | number): Money {
    return new Money(this.value.times(new MoneyDecimal(percent)).dividedBy(100));
  }

  negate(): Money {
    return new Money(this.value.negated());
  }

  abs(): Money {
    return new Money(this.value.abs());
  }

  /**
   * Splits an amount into `n` parts whose sum is EXACTLY the original.
   *
   * Naively dividing ₹100 three ways gives 33.33 × 3 = 99.99 and loses a paisa.
   * This distributes the remainder one minor unit at a time across the leading
   * parts, which is the standard allocation algorithm and the only correct way
   * to split a payment or a discount across lines.
   */
  allocate(parts: number, scale: number = MONEY_DISPLAY_SCALE): Money[] {
    if (!Number.isInteger(parts) || parts < 1) {
      throw new RangeError(`Money.allocate requires a positive integer, received ${parts}`);
    }
    const unit = new MoneyDecimal(10).pow(-scale);
    const total = this.value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
    const base = total.dividedBy(parts).toDecimalPlaces(scale, Decimal.ROUND_DOWN);

    const result: Money[] = Array.from({ length: parts }, () => new Money(base));
    let distributed = base.times(parts);
    let index = 0;
    while (distributed.lessThan(total)) {
      const current = result[index];
      // Bounds are guaranteed by the modulo, but noUncheckedIndexedAccess is on.
      if (current) result[index] = new Money(current.value.plus(unit));
      distributed = distributed.plus(unit);
      index = (index + 1) % parts;
    }
    return result;
  }

  /** Distributes proportionally by weight, preserving the exact total. */
  allocateByWeights(weights: readonly (string | number)[], scale = MONEY_DISPLAY_SCALE): Money[] {
    const decimals = weights.map((w) => new MoneyDecimal(w));
    const totalWeight = decimals.reduce((a, b) => a.plus(b), new MoneyDecimal(0));
    if (totalWeight.isZero()) return this.allocate(weights.length, scale);

    const total = this.value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
    const shares = decimals.map((w) =>
      total.times(w).dividedBy(totalWeight).toDecimalPlaces(scale, Decimal.ROUND_DOWN),
    );
    const allocated = shares.reduce((a, b) => a.plus(b), new MoneyDecimal(0));
    const unit = new MoneyDecimal(10).pow(-scale);

    let remainder = total.minus(allocated);
    let index = 0;
    while (remainder.greaterThan(0) && shares.length > 0) {
      shares[index] = (shares[index] ?? new MoneyDecimal(0)).plus(unit);
      remainder = remainder.minus(unit);
      index = (index + 1) % shares.length;
    }
    return shares.map((s) => new Money(s));
  }

  // ── Rounding ──────────────────────────────────────────────────────────────

  round(scale: number = MONEY_DISPLAY_SCALE): Money {
    return new Money(this.value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP));
  }

  /**
   * Rounds to the nearest whole rupee and reports the adjustment, which is what
   * an invoice's `round_off` column records.
   */
  roundToWhole(): { amount: Money; roundOff: Money } {
    const rounded = new Money(this.value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP));
    return { amount: rounded, roundOff: rounded.subtract(this) };
  }

  // ── Comparison ────────────────────────────────────────────────────────────

  equals(other: MoneyInput): boolean {
    return this.value.equals(Money.of(other).value);
  }
  gt(other: MoneyInput): boolean {
    return this.value.greaterThan(Money.of(other).value);
  }
  gte(other: MoneyInput): boolean {
    return this.value.greaterThanOrEqualTo(Money.of(other).value);
  }
  lt(other: MoneyInput): boolean {
    return this.value.lessThan(Money.of(other).value);
  }
  lte(other: MoneyInput): boolean {
    return this.value.lessThanOrEqualTo(Money.of(other).value);
  }
  isZero(): boolean {
    return this.value.isZero();
  }
  isPositive(): boolean {
    return this.value.greaterThan(0);
  }
  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  // ── Output ────────────────────────────────────────────────────────────────

  /** Canonical wire and storage form: fixed 4 decimal places. */
  toString(): string {
    return this.value.toFixed(MONEY_SCALE);
  }

  toJSON(): string {
    return this.toString();
  }

  /** Presentation form: 2 decimal places, no symbol. */
  toDisplayString(): string {
    return this.value.toFixed(MONEY_DISPLAY_SCALE);
  }

  /** Indian-format currency, e.g. `₹1,52,400.00`. */
  format(currency = 'INR', locale = 'en-IN'): string {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: MONEY_DISPLAY_SCALE,
      maximumFractionDigits: MONEY_DISPLAY_SCALE,
    }).format(this.value.toDecimalPlaces(MONEY_DISPLAY_SCALE).toNumber());
  }

  toDecimal(): Decimal {
    return this.value;
  }

  /**
   * Escape hatch for charting libraries only. Never use the result for
   * arithmetic that feeds back into a stored amount.
   */
  toNumber(): number {
    return this.value.toNumber();
  }
}

/** Convenience alias so call sites read naturally: `money('1250.00')`. */
export const money = (input: MoneyInput): Money => Money.of(input);

// ── Zod schemas ─────────────────────────────────────────────────────────────

const MONEY_STRING = /^-?\d{1,15}(\.\d{1,4})?$/;

/**
 * Accepts a decimal string (canonical) or a number (developer convenience) and
 * always yields a normalised 4-decimal string. Rejecting `1e5`, `NaN`, and
 * thousands separators here means no downstream layer has to.
 */
export const moneySchema = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const raw = typeof v === 'number' ? v.toString() : v.trim();
    if (!MONEY_STRING.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Must be a decimal amount with at most 4 decimal places, e.g. "152400.00". ' +
          'Scientific notation and thousands separators are not accepted.',
      });
      return z.NEVER;
    }
    return Money.of(raw).toString();
  })
  .describe('Monetary amount as a decimal string with 4 decimal places');

/** Money that must not be negative — prices, quantities, credit limits. */
export const positiveMoneySchema = moneySchema.refine((v) => Money.of(v).gte(0), {
  message: 'Must not be negative',
});

/** Money that must be strictly greater than zero — payment amounts. */
export const nonZeroMoneySchema = moneySchema.refine((v) => Money.of(v).isPositive(), {
  message: 'Must be greater than zero',
});

/** Quantities share money's exactness requirement (services bill in part-hours). */
export const quantitySchema = moneySchema.refine((v) => Money.of(v).isPositive(), {
  message: 'Quantity must be greater than zero',
});

/** Percentage 0–100 with up to 4 decimal places. */
export const percentSchema = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const raw = typeof v === 'number' ? v.toString() : v.trim();
    if (!/^\d{1,3}(\.\d{1,4})?$/.test(raw)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be a percentage, e.g. "18.5"' });
      return z.NEVER;
    }
    const parsed = Money.of(raw);
    if (parsed.gt(100)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must not exceed 100' });
      return z.NEVER;
    }
    return parsed.toString();
  })
  .describe('Percentage between 0 and 100');
