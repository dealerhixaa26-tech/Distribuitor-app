import type { AnalyticsPeriod } from '@hixaa/contracts';

/**
 * Period resolution for every KPI.
 *
 * ── Why the comparison period is the same LENGTH, not the previous calendar one ──
 *
 * On the 3rd of the month, MTD covers three days. Comparing that against the
 * whole of last month reports a ~90% collapse in revenue, every month, on the
 * 1st, 2nd and 3rd — and a metric that lies predictably is a metric nobody
 * reads on the 4th either.
 *
 * So the baseline is the same number of days immediately before the current
 * period starts: three days of this month against the first three days of last
 * month. That answers the question a person is actually asking — "are we ahead
 * of where we were?" — rather than an arithmetic accident.
 *
 * Pure, and takes `now` explicitly: every boundary here is testable without
 * mocking time, which matters because financial-year and quarter arithmetic is
 * exactly the sort of thing that is quietly wrong for one month a year.
 */

export interface ResolvedPeriod {
  from: Date;
  to: Date;
  comparedFrom: Date;
  comparedTo: Date;
  /** 0–1, how far through the period we are. Targets read this. */
  elapsedFraction: number;
}

const DAY_MS = 86_400_000;

/** Midnight UTC on the day `date` falls in. */
const startOfDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/**
 * The Indian financial year starts on 1 April.
 *
 * Shared with `financialYearOf` in contracts, and restated here because FYTD
 * needs the start DATE rather than the label.
 */
const financialYearStart = (date: Date): Date => {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return new Date(Date.UTC(month >= 4 ? year : year - 1, 3, 1));
};

export function resolvePeriod(period: AnalyticsPeriod, now: Date): ResolvedPeriod {
  const today = startOfDay(now);
  // Inclusive of today: "month to date" includes what happened this morning.
  const to = new Date(today.getTime() + DAY_MS - 1);

  let from: Date;
  let periodEnd: Date;

  switch (period) {
    case 'TODAY':
      from = today;
      periodEnd = to;
      break;
    case 'WTD': {
      // Monday-start. A sales week that begins on Sunday would put Monday's
      // orders in the previous week for the whole of Monday.
      const dayOfWeek = (today.getUTCDay() + 6) % 7;
      from = new Date(today.getTime() - dayOfWeek * DAY_MS);
      periodEnd = new Date(from.getTime() + 7 * DAY_MS - 1);
      break;
    }
    case 'MTD':
      from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      periodEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1) - 1);
      break;
    case 'QTD': {
      const quarterStartMonth = Math.floor(today.getUTCMonth() / 3) * 3;
      from = new Date(Date.UTC(today.getUTCFullYear(), quarterStartMonth, 1));
      periodEnd = new Date(Date.UTC(today.getUTCFullYear(), quarterStartMonth + 3, 1) - 1);
      break;
    }
    case 'YTD':
      from = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
      periodEnd = new Date(Date.UTC(today.getUTCFullYear() + 1, 0, 1) - 1);
      break;
    case 'FYTD':
      from = financialYearStart(today);
      periodEnd = new Date(
        Date.UTC(from.getUTCFullYear() + 1, 3, 1) - 1,
      );
      break;
  }

  // The comparison window: the same elapsed span, immediately before `from`.
  const elapsedMs = to.getTime() - from.getTime();
  const comparedTo = new Date(from.getTime() - 1);
  const comparedFrom = new Date(comparedTo.getTime() - elapsedMs);

  const totalMs = periodEnd.getTime() - from.getTime();
  const elapsedFraction = totalMs <= 0 ? 1 : Math.min(1, elapsedMs / totalMs);

  return { from, to, comparedFrom, comparedTo, elapsedFraction };
}

/** The last N whole months, oldest first, as `YYYY-MM` plus bounds. */
export function monthWindows(
  months: number,
  now: Date,
): Array<{ month: string; from: Date; to: Date }> {
  const windows: Array<{ month: string; from: Date; to: Date }> = [];
  const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  for (let index = months - 1; index >= 0; index--) {
    const from = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - index, 1));
    const to = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1) - 1,
    );
    windows.push({
      month: `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}`,
      from,
      to,
    });
  }

  return windows;
}
