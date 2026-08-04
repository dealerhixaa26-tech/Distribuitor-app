import { Money } from '@hixaa/contracts';
import { applyDiscount, selectDiscount, type DiscountRuleInput } from './discount-resolver';

/**
 * Discount resolution.
 *
 * The rule that matters most here is that discounts do NOT stack (ADR-0007 §3),
 * and that every rule which did not apply says why. A discount nobody can
 * explain is a discount nobody can defend at a margin review.
 */

const rule = (over: Partial<DiscountRuleInput> = {}): DiscountRuleInput => ({
  id: over.code ?? 'id-default',
  code: 'DEFAULT',
  name: 'Default rule',
  scope: 'GLOBAL',
  type: 'PERCENT',
  value: '10',
  minQty: null,
  minAmount: null,
  maxDiscountAmount: null,
  priority: 100,
  ...over,
});

describe('selectDiscount — eligibility', () => {
  it('returns no winner when there are no rules', () => {
    const result = selectDiscount([], '1', Money.of('1000'));
    expect(result.winner).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it('applies a rule whose thresholds are all satisfied', () => {
    const result = selectDiscount([rule({ id: 'a', code: 'A' })], '1', Money.of('1000'));
    expect(result.winner?.code).toBe('A');
    expect(result.candidates[0]?.applied).toBe(true);
    expect(result.candidates[0]?.rejectedBecause).toBeUndefined();
  });

  it('rejects a rule below its minimum quantity, and says so', () => {
    const result = selectDiscount(
      [rule({ id: 'a', code: 'A', minQty: '10' })],
      '5',
      Money.of('1000'),
    );
    expect(result.winner).toBeNull();
    expect(result.candidates[0]?.applied).toBe(false);
    expect(result.candidates[0]?.rejectedBecause).toContain('below the rule');
    expect(result.candidates[0]?.rejectedBecause).toContain('10');
  });

  it('rejects a rule below its minimum line amount, and says so', () => {
    const result = selectDiscount(
      [rule({ id: 'a', code: 'A', minAmount: '1000000' })],
      '1',
      Money.of('742000'),
    );
    expect(result.winner).toBeNull();
    expect(result.candidates[0]?.rejectedBecause).toContain('742000.00');
    expect(result.candidates[0]?.rejectedBecause).toContain('1000000.00');
  });

  it('applies a rule exactly AT its threshold — the boundary is inclusive', () => {
    const result = selectDiscount(
      [rule({ id: 'a', code: 'A', minQty: '10', minAmount: '1000' })],
      '10',
      Money.of('1000'),
    );
    expect(result.winner?.code).toBe('A');
  });
});

describe('selectDiscount — exactly one winner', () => {
  it('never applies more than one rule, however many match', () => {
    const result = selectDiscount(
      [
        rule({ id: 'a', code: 'A', value: '15', priority: 10 }),
        rule({ id: 'b', code: 'B', value: '15', priority: 20 }),
        rule({ id: 'c', code: 'C', value: '15', priority: 30 }),
      ],
      '1',
      Money.of('1000'),
    );

    // Three eligible rules, one winner. Stacking these would give 45% off.
    expect(result.candidates.filter((c) => c.applied)).toHaveLength(1);
    expect(result.winner?.code).toBe('A');
  });

  it('prefers the lower priority number', () => {
    const result = selectDiscount(
      [rule({ id: 'a', code: 'A', priority: 50 }), rule({ id: 'b', code: 'B', priority: 5 })],
      '1',
      Money.of('1000'),
    );
    expect(result.winner?.code).toBe('B');
  });

  it('breaks a priority tie on scope specificity — PRODUCT beats CATEGORY beats GLOBAL', () => {
    const result = selectDiscount(
      [
        rule({ id: 'g', code: 'G', scope: 'GLOBAL', priority: 100 }),
        rule({ id: 'c', code: 'C', scope: 'CATEGORY', priority: 100 }),
        rule({ id: 'p', code: 'P', scope: 'PRODUCT', priority: 100 }),
        rule({ id: 'd', code: 'D', scope: 'DISTRIBUTOR', priority: 100 }),
      ],
      '1',
      Money.of('1000'),
    );
    expect(result.winner?.scope).toBe('PRODUCT');
  });

  it('breaks a full tie deterministically on code', () => {
    // Without this final tie-break the winner would depend on the order the
    // database happened to return rows, so the same quote could price
    // differently on two runs.
    const forward = selectDiscount(
      [
        rule({ id: 'z', code: 'ZULU', scope: 'GLOBAL', priority: 100 }),
        rule({ id: 'a', code: 'ALPHA', scope: 'GLOBAL', priority: 100 }),
      ],
      '1',
      Money.of('1000'),
    );
    const reversed = selectDiscount(
      [
        rule({ id: 'a', code: 'ALPHA', scope: 'GLOBAL', priority: 100 }),
        rule({ id: 'z', code: 'ZULU', scope: 'GLOBAL', priority: 100 }),
      ],
      '1',
      Money.of('1000'),
    );
    expect(forward.winner?.code).toBe('ALPHA');
    expect(reversed.winner?.code).toBe('ALPHA');
  });

  it('explains why each loser lost, naming the winner', () => {
    const result = selectDiscount(
      [rule({ id: 'a', code: 'A', priority: 10 }), rule({ id: 'b', code: 'B', priority: 20 })],
      '1',
      Money.of('1000'),
    );
    const loser = result.candidates.find((c) => c.code === 'B');
    expect(loser?.applied).toBe(false);
    expect(loser?.rejectedBecause).toContain('outranked by A');
  });

  it('reports every rule it considered, winners and losers alike', () => {
    const result = selectDiscount(
      [
        rule({ id: 'a', code: 'A', priority: 10 }),
        rule({ id: 'b', code: 'B', priority: 20 }),
        rule({ id: 'c', code: 'C', minQty: '99' }),
      ],
      '1',
      Money.of('1000'),
    );
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((c) => c.applied || c.rejectedBecause)).toBe(true);
  });
});

describe('applyDiscount', () => {
  it('reduces the unit price by a percentage', () => {
    const result = applyDiscount(rule({ type: 'PERCENT', value: '5' }), Money.of('742000'), '1');
    expect(result.toString()).toBe('704900.0000');
  });

  it('treats a FLAT rule as an amount off each UNIT', () => {
    const result = applyDiscount(rule({ type: 'FLAT', value: '200' }), Money.of('4200'), '50');
    expect(result.toString()).toBe('4000.0000');
  });

  it('never inverts a line when a flat discount exceeds the price', () => {
    // Otherwise the company would be paying the customer to take the goods.
    const result = applyDiscount(rule({ type: 'FLAT', value: '9999' }), Money.of('4200'), '1');
    expect(result.toString()).toBe('0.0000');
    expect(result.isNegative()).toBe(false);
  });

  it('caps the LINE discount at maxDiscountAmount', () => {
    // 10% of ₹1,00,000 × 10 units = ₹1,00,000 of discount, capped at ₹25,000,
    // which is ₹2,500 per unit.
    const result = applyDiscount(
      rule({ type: 'PERCENT', value: '10', maxDiscountAmount: '25000' }),
      Money.of('100000'),
      '10',
    );
    expect(result.toString()).toBe('97500.0000');
  });

  it('leaves the discount alone when it is under the cap', () => {
    const result = applyDiscount(
      rule({ type: 'PERCENT', value: '10', maxDiscountAmount: '999999' }),
      Money.of('100000'),
      '10',
    );
    expect(result.toString()).toBe('90000.0000');
  });

  it('scales the cap with quantity — the same rule caps differently at 1 and at 10', () => {
    const capped = rule({ type: 'PERCENT', value: '50', maxDiscountAmount: '1000' });
    expect(applyDiscount(capped, Money.of('10000'), '1').toString()).toBe('9000.0000');
    // At quantity 10 the ₹1,000 cap spreads to ₹100 per unit.
    expect(applyDiscount(capped, Money.of('10000'), '10').toString()).toBe('9900.0000');
  });

  it('handles a 100% rule without producing a negative price', () => {
    const result = applyDiscount(rule({ type: 'PERCENT', value: '100' }), Money.of('4200'), '1');
    expect(result.toString()).toBe('0.0000');
  });
});
