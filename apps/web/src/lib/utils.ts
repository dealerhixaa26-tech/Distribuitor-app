import { Money } from '@hixaa/contracts';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merges Tailwind classes, with later utilities winning conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Formats a monetary amount that arrived from the API as a STRING.
 *
 * Never `Number(value)` a money field. JSON numbers are IEEE-754 doubles, and
 * coercing here would reintroduce exactly the precision loss ADR-0004 removes
 * on the server. `Money` parses the decimal string exactly.
 */
export function formatMoney(value: string | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined || value === '') return '—';
  const money = Money.tryParse(value);
  if (!money) return '—';
  return money.format(currency);
}

/** Amount without the currency symbol — for tight table columns. */
export function formatAmount(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const money = Money.tryParse(value);
  if (!money) return '—';
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(money.toNumber());
}

/** Indian short-scale abbreviation — 1.5 Cr, 82.3 L, 4.2 K. */
export function formatCompactAmount(value: string | null | undefined): string {
  const money = value ? Money.tryParse(value) : null;
  if (!money) return '—';
  const n = money.toNumber();
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return n.toFixed(0);
}

const DATE_TZ = 'Asia/Kolkata';

/** Stored UTC, displayed in IST — the timezone the business operates in. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: DATE_TZ,
  }).format(date);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DATE_TZ,
  }).format(date);
}

/** "2 hours ago", "in 3 days" — for activity feeds and due dates. */
export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';

  const seconds = (date.getTime() - Date.now()) / 1000;
  const formatter = new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' });

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];

  for (const [unit, secondsPerUnit] of units) {
    if (Math.abs(seconds) >= secondsPerUnit) {
      return formatter.format(Math.round(seconds / secondsPerUnit), unit);
    }
  }
  return formatter.format(Math.round(seconds), 'second');
}

/** "Vidarbha Automation LLP" → "VA" */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

// maskTail now lives in @hixaa/contracts so the API (masking on write) and the
// web (masking on display) cannot disagree about how much is revealed.
export { maskTailValue as maskTail } from '@hixaa/contracts';

/** ENUM_VALUE → "Enum value" for display. */
export function humanizeEnum(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .toLowerCase()
    .split('_')
    .join(' ')
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Default date-range bounds for a report form.
 *
 * The `no-restricted-syntax` clock rule exists so time-dependent LOGIC stays
 * testable by injecting a clock. It does not fit here: this is a browser with
 * no DI container, and the value is the initial content of a date input that
 * the user immediately sees and can change. There is no assertion to make about
 * it and nothing downstream depends on it — the server re-derives every figure
 * from the dates actually submitted.
 *
 * Kept in one place rather than inlined so the exception is stated once.
 */
// eslint-disable-next-line no-restricted-syntax
export const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** 1 April of the current Indian financial year, as `YYYY-MM-DD`. */
export function financialYearStartIso(): string {
  // eslint-disable-next-line no-restricted-syntax
  const now = new Date();
  const year = now.getUTCFullYear();
  return `${now.getUTCMonth() + 1 >= 4 ? year : year - 1}-04-01`;
}
