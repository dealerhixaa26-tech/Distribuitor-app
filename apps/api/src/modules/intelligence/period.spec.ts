import { monthWindows, resolvePeriod } from './period';

/**
 * Period arithmetic is the part of analytics most likely to be quietly wrong,
 * and wrong in a way nobody notices until a month turns over. It is pure and
 * takes `now` explicitly for exactly this reason.
 */

const at = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const day = (date: Date): string => date.toISOString().slice(0, 10);

describe('resolvePeriod — the comparison window', () => {
  it('compares MTD against the SAME NUMBER OF DAYS of the previous month', () => {
    // The bug this prevents: on the 3rd, comparing 3 days against a whole
    // month reports a ~90% collapse in revenue — every month, predictably.
    const period = resolvePeriod('MTD', at('2026-08-03'));

    expect(day(period.from)).toBe('2026-08-01');
    expect(day(period.to)).toBe('2026-08-03');
    // Three days of August against the three days immediately before August.
    expect(day(period.comparedFrom)).toBe('2026-07-29');
    expect(day(period.comparedTo)).toBe('2026-07-31');
  });

  it('never lets the comparison window overlap the current one', () => {
    for (const date of ['2026-01-01', '2026-02-28', '2026-08-05', '2026-12-31']) {
      for (const p of ['TODAY', 'WTD', 'MTD', 'QTD', 'YTD', 'FYTD'] as const) {
        const period = resolvePeriod(p, at(date));
        expect(period.comparedTo.getTime()).toBeLessThan(period.from.getTime());
        expect(period.comparedFrom.getTime()).toBeLessThanOrEqual(period.comparedTo.getTime());
      }
    }
  });

  it('starts the week on MONDAY', () => {
    // 2026-08-05 is a Wednesday. A Sunday-start week would put Monday's and
    // Tuesday's orders in the previous week for the whole of Monday.
    const period = resolvePeriod('WTD', at('2026-08-05'));
    expect(day(period.from)).toBe('2026-08-03');
  });

  it('runs the financial year from 1 April', () => {
    // The whole finance module resets on this boundary; FYTD must agree.
    expect(day(resolvePeriod('FYTD', at('2026-08-05')).from)).toBe('2026-04-01');
    // March belongs to the PREVIOUS financial year.
    expect(day(resolvePeriod('FYTD', at('2026-03-31')).from)).toBe('2025-04-01');
    expect(day(resolvePeriod('FYTD', at('2026-04-01')).from)).toBe('2026-04-01');
  });

  it('puts each calendar quarter on its own boundary', () => {
    expect(day(resolvePeriod('QTD', at('2026-02-14')).from)).toBe('2026-01-01');
    expect(day(resolvePeriod('QTD', at('2026-05-14')).from)).toBe('2026-04-01');
    expect(day(resolvePeriod('QTD', at('2026-08-14')).from)).toBe('2026-07-01');
    expect(day(resolvePeriod('QTD', at('2026-11-14')).from)).toBe('2026-10-01');
  });

  it('reports elapsed fraction, which is what a target status reads', () => {
    // Mid-August: roughly half a month gone.
    const mid = resolvePeriod('MTD', at('2026-08-16'));
    expect(mid.elapsedFraction).toBeGreaterThan(0.45);
    expect(mid.elapsedFraction).toBeLessThan(0.55);

    // On the last day, effectively the whole period.
    const end = resolvePeriod('MTD', at('2026-08-31'));
    expect(end.elapsedFraction).toBeGreaterThan(0.99);
  });

  it('treats TODAY as a single whole day', () => {
    const period = resolvePeriod('TODAY', at('2026-08-05'));
    expect(day(period.from)).toBe('2026-08-05');
    expect(day(period.to)).toBe('2026-08-05');
    expect(day(period.comparedFrom)).toBe('2026-08-04');
    expect(day(period.comparedTo)).toBe('2026-08-04');
  });
});

describe('monthWindows', () => {
  it('returns N months ending with the current one, oldest first', () => {
    const windows = monthWindows(3, at('2026-08-05'));
    expect(windows.map((w) => w.month)).toEqual(['2026-06', '2026-07', '2026-08']);
  });

  it('crosses a year boundary without gaps or repeats', () => {
    const windows = monthWindows(4, at('2026-02-10'));
    expect(windows.map((w) => w.month)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('bounds each window to its own month', () => {
    const [february] = monthWindows(1, at('2026-02-10'));
    expect(february).toBeDefined();
    expect(day(february!.from)).toBe('2026-02-01');
    // 2026 is not a leap year — the window must end on the 28th, not the 29th.
    expect(day(february!.to)).toBe('2026-02-28');
  });

  it('handles a leap February', () => {
    const [leap] = monthWindows(1, at('2028-02-10'));
    expect(day(leap!.to)).toBe('2028-02-29');
  });
});
