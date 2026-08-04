import { describe, expect, it } from 'vitest';
import { Money, money, moneySchema, percentSchema, positiveMoneySchema } from '../money';

describe('Money', () => {
  describe('the floating-point problem this class exists to solve', () => {
    it('adds 0.1 + 0.2 to exactly 0.3', () => {
      // The canonical demonstration: 0.1 + 0.2 === 0.30000000000000004 in IEEE-754.
      expect(0.1 + 0.2).not.toBe(0.3);
      expect(money('0.1').add('0.2').equals('0.3')).toBe(true);
    });

    it('keeps large invoice amounts exact', () => {
      const total = money('48750000.5500').add('0.4500');
      expect(total.toString()).toBe('48750001.0000');
    });

    it('does not drift when summing many lines', () => {
      const lines = Array.from({ length: 1000 }, () => money('0.01'));
      expect(Money.sum(lines).toString()).toBe('10.0000');
    });
  });

  describe('construction', () => {
    it('accepts strings, numbers, and other Money instances', () => {
      expect(money('1250.50').toString()).toBe('1250.5000');
      expect(money(1250.5).toString()).toBe('1250.5000');
      expect(money(money('1250.50')).toString()).toBe('1250.5000');
    });

    it('rejects non-finite numbers rather than producing NaN downstream', () => {
      expect(() => money(Number.NaN)).toThrow(TypeError);
      expect(() => money(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    });

    it('returns null from tryParse for unparseable input', () => {
      expect(Money.tryParse('not-a-number')).toBeNull();
      expect(Money.tryParse(null)).toBeNull();
      expect(Money.tryParse('1250.50')?.toString()).toBe('1250.5000');
    });
  });

  describe('arithmetic', () => {
    it('computes a percentage', () => {
      expect(money('10000').percentage(18).toString()).toBe('1800.0000');
      expect(money('10000').percentage('2.5').toString()).toBe('250.0000');
    });

    it('refuses to divide by zero', () => {
      expect(() => money('100').divide(0)).toThrow(RangeError);
    });

    it('compares without coercion', () => {
      expect(money('100.00').equals('100')).toBe(true);
      expect(money('100.01').gt('100')).toBe(true);
      expect(money('99.99').lt('100')).toBe(true);
      expect(money('0').isZero()).toBe(true);
      expect(money('-5').isNegative()).toBe(true);
    });
  });

  describe('allocate — the paisa must never disappear', () => {
    it('splits 100 three ways without losing a paisa', () => {
      const parts = money('100').allocate(3);
      expect(parts.map((p) => p.toDisplayString())).toEqual(['33.34', '33.33', '33.33']);
      expect(Money.sum(parts).round(2).toString()).toBe('100.0000');
    });

    it('preserves the exact total for every split from 1 to 50', () => {
      // Property test: whatever the divisor, the parts must re-sum to the whole.
      for (let parts = 1; parts <= 50; parts++) {
        for (const amount of ['100', '0.05', '99999.99', '1', '7.77']) {
          const split = money(amount).allocate(parts);
          expect(split).toHaveLength(parts);
          expect(Money.sum(split).toString()).toBe(money(amount).round(2).toString());
        }
      }
    });

    it('allocates proportionally by weight and still preserves the total', () => {
      const parts = money('1000').allocateByWeights([1, 2, 7]);
      expect(Money.sum(parts).toString()).toBe('1000.0000');
      expect(parts[2]?.toDisplayString()).toBe('700.00');
    });

    it('rejects a non-positive part count', () => {
      expect(() => money('100').allocate(0)).toThrow(RangeError);
      expect(() => money('100').allocate(1.5)).toThrow(RangeError);
    });
  });

  describe('rounding', () => {
    it('rounds half away from zero, as Indian invoicing expects', () => {
      expect(money('2.005').round(2).toDisplayString()).toBe('2.01');
      expect(money('2.004').round(2).toDisplayString()).toBe('2.00');
    });

    it('reports the round-off adjustment an invoice must record', () => {
      const { amount, roundOff } = money('1179.47').roundToWhole();
      expect(amount.toDisplayString()).toBe('1179.00');
      expect(roundOff.toDisplayString()).toBe('-0.47');
      expect(amount.subtract(roundOff).equals('1179.47')).toBe(true);
    });
  });

  describe('serialisation', () => {
    it('serialises to a string, never a JSON number', () => {
      const payload = JSON.parse(JSON.stringify({ total: money('152400.50') }));
      expect(payload.total).toBe('152400.5000');
      expect(typeof payload.total).toBe('string');
    });

    it('formats as Indian currency', () => {
      // Indian grouping is 2,2,3 — not the 3,3,3 of most locales.
      expect(money('152400.50').format()).toContain('1,52,400.50');
    });
  });
});

describe('moneySchema', () => {
  it('normalises valid input to 4 decimal places', () => {
    expect(moneySchema.parse('1250.5')).toBe('1250.5000');
    expect(moneySchema.parse(1250)).toBe('1250.0000');
  });

  it('rejects scientific notation and thousands separators', () => {
    // Both parse happily as JS numbers, and both would be wrong.
    expect(moneySchema.safeParse('1e5').success).toBe(false);
    expect(moneySchema.safeParse('1,250.00').success).toBe(false);
    expect(moneySchema.safeParse('abc').success).toBe(false);
  });

  it('rejects more than 4 decimal places rather than silently truncating', () => {
    expect(moneySchema.safeParse('1.00001').success).toBe(false);
  });

  it('enforces non-negative where required', () => {
    expect(positiveMoneySchema.safeParse('-1').success).toBe(false);
    expect(positiveMoneySchema.safeParse('0').success).toBe(true);
  });
});

describe('percentSchema', () => {
  it('accepts valid percentages', () => {
    expect(percentSchema.parse('18.5')).toBe('18.5000');
    expect(percentSchema.parse(0)).toBe('0.0000');
  });

  it('rejects values above 100 and negatives', () => {
    expect(percentSchema.safeParse('101').success).toBe(false);
    expect(percentSchema.safeParse('-5').success).toBe(false);
  });
});
