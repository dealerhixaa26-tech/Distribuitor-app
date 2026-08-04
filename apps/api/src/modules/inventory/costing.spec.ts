import { Money } from '@hixaa/contracts';
import { ledgerUnitCost, nextAverageCost, stockValue } from './costing';

/**
 * Moving weighted-average costing (ADR-0010).
 *
 * These figures end up in an inventory valuation that an auditor will ask about
 * years from now, so the edge cases are pinned rather than assumed: an empty
 * bin, a costless receipt, an outbound movement, and the repeating decimals
 * that a float would drift on.
 */

const m = (v: string) => Money.of(v);

describe('nextAverageCost — the formula', () => {
  it('averages a receipt into existing stock', () => {
    // 10 @ 100 + 10 @ 200 = 3000 / 20 = 150
    const result = nextAverageCost({
      onHandBefore: m('10'),
      currentAverage: m('100'),
      movementQuantity: m('10'),
      movementUnitCost: '200',
    });
    expect(result.toString()).toBe('150.0000');
  });

  it('weights by quantity, not by receipt count', () => {
    // 90 @ 100 + 10 @ 200 = 11000 / 100 = 110, not 150
    const result = nextAverageCost({
      onHandBefore: m('90'),
      currentAverage: m('100'),
      movementQuantity: m('10'),
      movementUnitCost: '200',
    });
    expect(result.toString()).toBe('110.0000');
  });

  it('adopts the receipt cost when the bin is empty', () => {
    // Averaging against zero on-hand is a division by zero dressed as a formula.
    const result = nextAverageCost({
      onHandBefore: m('0'),
      currentAverage: m('0'),
      movementQuantity: m('50'),
      movementUnitCost: '84000',
    });
    expect(result.toString()).toBe('84000.0000');
  });

  it('adopts the receipt cost when the bin is empty but an average lingers', () => {
    // Stock went to zero, the old average is stale, a new receipt defines it.
    const result = nextAverageCost({
      onHandBefore: m('0'),
      currentAverage: m('100'),
      movementQuantity: m('5'),
      movementUnitCost: '250',
    });
    expect(result.toString()).toBe('250.0000');
  });
});

describe('nextAverageCost — the rules that stop silent corruption', () => {
  it('leaves the average untouched on an OUTBOUND movement', () => {
    // The defining property: issuing stock does not change what the rest cost.
    const result = nextAverageCost({
      onHandBefore: m('100'),
      currentAverage: m('137.5'),
      movementQuantity: m('-40'),
      movementUnitCost: '9999',
    });
    expect(result.toString()).toBe('137.5000');
  });

  it('keeps the current average when a receipt states NO cost', () => {
    // Treating "no cost given" as zero drags the average down and understates
    // inventory — invisible until a year-end valuation.
    const result = nextAverageCost({
      onHandBefore: m('10'),
      currentAverage: m('100'),
      movementQuantity: m('10'),
      movementUnitCost: null,
    });
    expect(result.toString()).toBe('100.0000');
  });

  it('does NOT silently treat a costless receipt as free stock', () => {
    const naiveZero = nextAverageCost({
      onHandBefore: m('10'),
      currentAverage: m('100'),
      movementQuantity: m('10'),
      movementUnitCost: '0',
    });
    // An EXPLICIT zero cost is honoured — free samples are real — and gives 50.
    // The point is that it differs from the null case above, which gives 100.
    expect(naiveZero.toString()).toBe('50.0000');
  });
});

describe('nextAverageCost — precision', () => {
  it('holds a repeating decimal at four places without drifting', () => {
    // 3 @ 10 + 0 ... 1 @ 20 → 50/4 = 12.5 exactly; then a third receipt makes
    // it repeat: (4 × 12.5 + 1 × 0) / 5 = 10
    const first = nextAverageCost({
      onHandBefore: m('3'),
      currentAverage: m('10'),
      movementQuantity: m('1'),
      movementUnitCost: '20',
    });
    expect(first.toString()).toBe('12.5000');
  });

  it('rounds a genuinely repeating average to the storage scale', () => {
    // (1 × 10 + 2 × 0) / 3 = 3.3333…
    const result = nextAverageCost({
      onHandBefore: m('1'),
      currentAverage: m('10'),
      movementQuantity: m('2'),
      movementUnitCost: '0',
    });
    expect(result.toString()).toBe('3.3333');
  });

  it('survives a long chain of receipts without accumulating float error', () => {
    // The scenario a float fails: many small receipts at awkward prices.
    let onHand = m('0');
    let average = m('0');
    for (let i = 1; i <= 100; i++) {
      const qty = m('3');
      average = nextAverageCost({
        onHandBefore: onHand,
        currentAverage: average,
        movementQuantity: qty,
        movementUnitCost: '0.1',
      });
      onHand = onHand.add(qty);
    }
    // Every receipt at the same price ⇒ the average is exactly that price.
    expect(average.toString()).toBe('0.1000');
    expect(onHand.toString()).toBe('300.0000');
  });

  it('handles a high-value industrial item without precision loss', () => {
    // 1 test bench @ 24,00,000 plus 1 @ 25,50,000
    const result = nextAverageCost({
      onHandBefore: m('1'),
      currentAverage: m('2400000'),
      movementQuantity: m('1'),
      movementUnitCost: '2550000',
    });
    expect(result.toString()).toBe('2475000.0000');
  });
});

describe('ledgerUnitCost', () => {
  it('records a receipt at what was actually paid', () => {
    const result = ledgerUnitCost({
      inbound: true,
      currentAverage: m('100'),
      movementUnitCost: '250',
    });
    expect(result.toString()).toBe('250.0000');
  });

  it('records an issue at the average prevailing BEFORE it', () => {
    // This is what makes the ledger a faithful COGS record rather than a
    // restatement at today's average.
    const result = ledgerUnitCost({
      inbound: false,
      currentAverage: m('137.5'),
      movementUnitCost: '9999',
    });
    expect(result.toString()).toBe('137.5000');
  });

  it('falls back to the average for a receipt with no stated cost', () => {
    const result = ledgerUnitCost({
      inbound: true,
      currentAverage: m('100'),
      movementUnitCost: null,
    });
    expect(result.toString()).toBe('100.0000');
  });
});

describe('stockValue', () => {
  it('multiplies quantity by average cost', () => {
    expect(stockValue(m('50'), m('4200')).toString()).toBe('210000.0000');
  });

  it('values an empty bin at zero regardless of the lingering average', () => {
    expect(stockValue(m('0'), m('84000')).toString()).toBe('0.0000');
  });

  it('keeps fractional quantities exact', () => {
    expect(stockValue(m('2.5'), m('1000.25')).toString()).toBe('2500.6250');
  });
});
