import { Money } from '@hixaa/contracts';
import { GstCalculator, type TaxLineResult } from './gst-calculator';

/**
 * The GST calculator's test suite.
 *
 * ADR-0008 requires that line taxes always sum to the document tax, verified
 * over generated invoices rather than a handful of fixtures. That property test
 * lives at the bottom of this file.
 *
 * It uses a SEEDED generator rather than a property-testing library. The
 * trade-off is deliberate: we give up automatic shrinking, and gain complete
 * reproducibility — a failure in CI is a failure that can be reproduced exactly
 * on a laptop, which for an invariant guarding a legal document is worth more
 * than a minimal counterexample. It also keeps the dependency surface where it
 * is. If the invariants grow beyond arithmetic, revisit and add fast-check.
 */

const HIXAA = '27'; // Maharashtra
const GUJARAT = '24';

/** GST slabs currently in force, from `GST_RATES` in @hixaa/contracts. */
const SLABS = ['0', '0.25', '3', '5', '12', '18', '28'] as const;

describe('GstCalculator.isInterState', () => {
  it('treats the same state as intra-state', () => {
    expect(GstCalculator.isInterState(HIXAA, HIXAA)).toBe(false);
  });

  it('treats a different state as inter-state', () => {
    expect(GstCalculator.isInterState(HIXAA, GUJARAT)).toBe(true);
  });

  it('ignores incidental whitespace rather than misclassifying the supply', () => {
    // A stray space arriving from a CSV import must not silently flip an
    // invoice from CGST+SGST to IGST — that is a defect the buyer discovers
    // when their input credit is rejected.
    expect(GstCalculator.isInterState(' 27', '27 ')).toBe(false);
  });
});

describe('GstCalculator.computeLine — intra-state', () => {
  it('splits GST into equal CGST and SGST halves', () => {
    const result = GstCalculator.computeLine(
      { taxableValue: Money.of('100000'), gstRate: '18' },
      false,
    );

    expect(result.cgst).toBe('9000.0000');
    expect(result.sgst).toBe('9000.0000');
    expect(result.igst).toBe('0.0000');
    expect(result.totalTax).toBe('18000.0000');
    expect(result.lineTotal).toBe('118000.0000');
  });

  it('charges no IGST on an intra-state supply', () => {
    const result = GstCalculator.computeLine(
      { taxableValue: Money.of('4999.99'), gstRate: '12' },
      false,
    );
    expect(result.igst).toBe('0.0000');
    expect(Money.of(result.cgst).add(result.sgst).toString()).toBe(result.totalTax);
  });
});

describe('GstCalculator.computeLine — inter-state', () => {
  it('charges the full rate as IGST and nothing as CGST or SGST', () => {
    const result = GstCalculator.computeLine(
      { taxableValue: Money.of('100000'), gstRate: '18' },
      true,
    );

    expect(result.igst).toBe('18000.0000');
    expect(result.cgst).toBe('0.0000');
    expect(result.sgst).toBe('0.0000');
    expect(result.totalTax).toBe('18000.0000');
  });

  it('produces the same total tax as the equivalent intra-state supply', () => {
    // The split differs; the amount the customer pays does not. If these ever
    // diverge, one of the two paths is wrong.
    const taxable = Money.of('87654.32');
    const intra = GstCalculator.computeLine({ taxableValue: taxable, gstRate: '18' }, false);
    const inter = GstCalculator.computeLine({ taxableValue: taxable, gstRate: '18' }, true);

    expect(intra.totalTax).toBe(inter.totalTax);
    expect(intra.lineTotal).toBe(inter.lineTotal);
  });
});

describe('GstCalculator.computeLine — every slab', () => {
  it.each(SLABS)('computes slab %s%% without drift', (rate) => {
    const taxable = Money.of('12345.67');
    const inter = GstCalculator.computeLine({ taxableValue: taxable, gstRate: rate }, true);

    // IGST at the full rate is the unambiguous reference: no halving, so no
    // rounding choice is involved.
    expect(inter.igst).toBe(taxable.percentage(rate).round(2).toString());
    expect(inter.totalTax).toBe(inter.igst);
  });

  it('charges nothing at the 0% slab, and still balances', () => {
    const result = GstCalculator.computeLine(
      { taxableValue: Money.of('50000'), gstRate: '0' },
      false,
    );
    expect(result.totalTax).toBe('0.0000');
    expect(result.lineTotal).toBe('50000.0000');
  });

  it('handles the 0.25% slab, where naive float maths drifts', () => {
    const result = GstCalculator.computeLine(
      { taxableValue: Money.of('99999.99'), gstRate: '0.25' },
      true,
    );
    // 99999.99 × 0.0025 = 249.999975 → 250.00 half-up
    expect(result.igst).toBe('250.0000');
  });
});

describe('GstCalculator.computeLine — cess', () => {
  it('adds cess on top of GST and includes it in the line total', () => {
    const result = GstCalculator.computeLine(
      { taxableValue: Money.of('10000'), gstRate: '28', cessRate: '12' },
      true,
    );
    expect(result.igst).toBe('2800.0000');
    expect(result.cess).toBe('1200.0000');
    expect(result.totalTax).toBe('4000.0000');
    expect(result.lineTotal).toBe('14000.0000');
  });

  it('defaults cess to zero when not supplied', () => {
    const result = GstCalculator.computeLine(
      { taxableValue: Money.of('10000'), gstRate: '18' },
      true,
    );
    expect(result.cess).toBe('0.0000');
  });
});

describe('GstCalculator.computeLine — rounding', () => {
  it('rounds half-up, the Indian invoicing convention', () => {
    // 100.10 × 2.5% = 2.5025 → 2.50; the .005 case is exercised below.
    const result = GstCalculator.computeLine(
      { taxableValue: Money.of('100.10'), gstRate: '5' },
      false,
    );
    expect(result.cgst).toBe('2.5000');
    expect(result.sgst).toBe('2.5000');
  });

  it('rounds a half-paisa away from zero rather than to even', () => {
    // 1.00 at 5% intra-state → each half is 0.025 → 0.03 half-up (not 0.02).
    const result = GstCalculator.computeLine(
      { taxableValue: Money.of('1.00'), gstRate: '5' },
      false,
    );
    expect(result.cgst).toBe('0.0300');
    expect(result.sgst).toBe('0.0300');
    // The two heads are rounded independently, so the total can exceed a
    // single-shot 5% calculation by a paisa. This is correct: CGST and SGST are
    // separate heads of tax and each is printed and filed in its own right.
    expect(result.totalTax).toBe('0.0600');
  });

  it('defines totalTax as the sum of its own components, never independently', () => {
    const taxable = Money.of('333.33');
    const result = GstCalculator.computeLine({ taxableValue: taxable, gstRate: '18' }, false);
    const componentSum = Money.of(result.cgst)
      .add(result.sgst)
      .add(result.igst)
      .add(result.cess);
    expect(componentSum.toString()).toBe(result.totalTax);
  });
});

describe('GstCalculator.computeDocument', () => {
  const line = (taxable: string, rate: string, inter = false): TaxLineResult =>
    GstCalculator.computeLine({ taxableValue: Money.of(taxable), gstRate: rate }, inter);

  it('sums already-rounded line values rather than re-deriving from the total', () => {
    // 1000.40 @ 9% = 90.036 → 90.04;  2000.30 @ 9% = 180.027 → 180.03
    // Summing the rounded lines gives 270.07. Re-deriving from the document
    // taxable value (3000.70 @ 9% = 270.063 → 270.06) gives a DIFFERENT answer,
    // and the portal computes line-wise — so the line-wise number is the
    // correct one. This test exists to pin that difference down.
    const doc = GstCalculator.computeDocument([line('1000.40', '18'), line('2000.30', '18')]);

    expect(doc.taxableValue).toBe('3000.7000');
    expect(doc.totalCgst).toBe('270.0700');
    expect(doc.totalSgst).toBe('270.0700');
    expect(doc.totalTax).toBe('540.1400');

    // The naive alternative, shown explicitly so the divergence is documented
    // rather than folklore.
    expect(Money.of('3000.70').percentage('9').round(2).toString()).toBe('270.0600');
  });

  it('absorbs the residual in roundOff so the grand total is whole', () => {
    const doc = GstCalculator.computeDocument([line('1000.40', '18'), line('2000.30', '18')]);

    const grand = Money.of(doc.grandTotal);
    // A whole rupee means no paise remain.
    expect(grand.toString().endsWith('.0000')).toBe(true);
    expect(Money.of(grand.toString()).subtract(doc.netTotal).toString()).toBe(doc.roundOff);
  });

  it('returns zeroes for an empty document rather than throwing', () => {
    const doc = GstCalculator.computeDocument([]);
    expect(doc.taxableValue).toBe('0.0000');
    expect(doc.totalTax).toBe('0.0000');
    expect(doc.grandTotal).toBe('0.0000');
  });

  it('keeps mixed rates and mixed heads separate', () => {
    // A real Hixaa invoice: an 18% gateway and a 12% service, intra-state.
    const doc = GstCalculator.computeDocument([line('100000', '18'), line('50000', '12')]);

    expect(doc.totalCgst).toBe('12000.0000'); // 9000 + 3000
    expect(doc.totalSgst).toBe('12000.0000');
    expect(doc.totalIgst).toBe('0.0000');
    expect(doc.totalTax).toBe('24000.0000');
  });
});

// ── The invariant ADR-0008 requires ─────────────────────────────────────────

/**
 * Deterministic pseudo-random generator (mulberry32).
 *
 * Seeded, so every run of this suite generates the identical corpus. A failure
 * here is reproducible by anyone, forever — which is the whole point when the
 * thing under test decides what goes on a tax invoice.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('GstCalculator — property: line taxes always sum to the document tax', () => {
  const INVOICES = 2000;

  it(`holds across ${INVOICES} generated invoices`, () => {
    const random = seededRandom(20260804);
    const failures: string[] = [];

    for (let invoice = 0; invoice < INVOICES; invoice++) {
      const interState = random() < 0.5;
      const lineCount = 1 + Math.floor(random() * 12);

      const lines: TaxLineResult[] = [];
      for (let i = 0; i < lineCount; i++) {
        // Values spanning a paisa to a crore, with awkward fractional parts —
        // the region where naive float arithmetic drifts.
        const rupees = Math.floor(random() * 10_000_000);
        const paise = Math.floor(random() * 100);
        const taxable = Money.of(`${rupees}.${String(paise).padStart(2, '0')}`);
        const rate = SLABS[Math.floor(random() * SLABS.length)] ?? '18';
        const cessRate = random() < 0.1 ? '12' : '0';

        lines.push(GstCalculator.computeLine({ taxableValue: taxable, gstRate: rate, cessRate }, interState));
      }

      const doc = GstCalculator.computeDocument(lines);

      const summedLineTax = Money.sum(lines.map((l) => l.totalTax));
      if (!summedLineTax.equals(doc.totalTax)) {
        failures.push(
          `invoice ${invoice}: lines summed to ${summedLineTax.toString()} but document reported ${doc.totalTax}`,
        );
        continue;
      }

      const summedComponents = Money.of(doc.totalCgst)
        .add(doc.totalSgst)
        .add(doc.totalIgst)
        .add(doc.totalCess);
      if (!summedComponents.equals(doc.totalTax)) {
        failures.push(
          `invoice ${invoice}: components summed to ${summedComponents.toString()} but total tax is ${doc.totalTax}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it(`keeps taxable + tax + roundOff === grandTotal across ${INVOICES} generated invoices`, () => {
    const random = seededRandom(19470815);
    const failures: string[] = [];

    for (let invoice = 0; invoice < INVOICES; invoice++) {
      const interState = random() < 0.5;
      const lineCount = 1 + Math.floor(random() * 8);

      const lines: TaxLineResult[] = [];
      for (let i = 0; i < lineCount; i++) {
        const rupees = Math.floor(random() * 500_000);
        const paise = Math.floor(random() * 100);
        const rate = SLABS[Math.floor(random() * SLABS.length)] ?? '18';
        lines.push(
          GstCalculator.computeLine(
            { taxableValue: Money.of(`${rupees}.${String(paise).padStart(2, '0')}`), gstRate: rate },
            interState,
          ),
        );
      }

      const doc = GstCalculator.computeDocument(lines);
      const reconstructed = Money.of(doc.taxableValue).add(doc.totalTax).add(doc.roundOff);

      if (!reconstructed.equals(doc.grandTotal)) {
        failures.push(
          `invoice ${invoice}: ${doc.taxableValue} + ${doc.totalTax} + ${doc.roundOff} = ${reconstructed.toString()}, expected ${doc.grandTotal}`,
        );
      }

      // The grand total must be a whole rupee, and roundOff must be under one.
      if (!doc.grandTotal.endsWith('.0000')) {
        failures.push(`invoice ${invoice}: grand total ${doc.grandTotal} is not a whole rupee`);
      }
      if (Money.of(doc.roundOff).abs().gte('0.50000001')) {
        failures.push(`invoice ${invoice}: roundOff ${doc.roundOff} exceeds half a rupee`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('never produces a negative tax from a non-negative taxable value', () => {
    const random = seededRandom(1);
    for (let i = 0; i < 500; i++) {
      const taxable = Money.of(`${Math.floor(random() * 1_000_000)}.${Math.floor(random() * 100)}`);
      const rate = SLABS[Math.floor(random() * SLABS.length)] ?? '18';
      const result = GstCalculator.computeLine({ taxableValue: taxable, gstRate: rate }, random() < 0.5);
      expect(Money.of(result.totalTax).isNegative()).toBe(false);
    }
  });
});

describe('GstCalculator.taxableFromInclusive', () => {
  it('backs a taxable value out of an inclusive amount', () => {
    // 118 inclusive at 18% → 100 taxable.
    const taxable = GstCalculator.taxableFromInclusive(Money.of('118'), '18');
    expect(taxable.round(2).toString()).toBe('100.0000');
  });

  it('round-trips forward and back within a paisa', () => {
    const taxable = Money.of('100');
    const inclusive = taxable.add(taxable.percentage('18'));
    expect(GstCalculator.taxableFromInclusive(inclusive, '18').round(2).toString()).toBe(
      '100.0000',
    );
  });
});
