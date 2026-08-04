import { Money } from './money';

/**
 * Indian number formatting and amount-in-words.
 *
 * Both are legally required on a GST tax invoice, and both are classic sources
 * of quiet error because Indian grouping is NOT the western thousands pattern:
 *
 *   western   12,345,678
 *   Indian     1,23,45,678      ← last three, then twos
 *
 * The scale names differ too — lakh (10^5) and crore (10^7) have no western
 * equivalent, so "million" never appears on an Indian invoice.
 *
 * Pure functions, tested exhaustively, because an invoice whose words disagree
 * with its figures is a defective legal document.
 */

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
] as const;

const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
] as const;

/** 0–99. The teens are irregular, hence the lookup rather than composition. */
function twoDigits(value: number): string {
  if (value < 20) return ONES[value] ?? '';
  const tens = TENS[Math.floor(value / 10)] ?? '';
  const ones = ONES[value % 10] ?? '';
  return ones ? `${tens} ${ones}` : tens;
}

/** 0–999. */
function threeDigits(value: number): string {
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest > 0) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/**
 * Groups digits the Indian way: `1234567.89` → `12,34,567.89`.
 *
 * `Intl.NumberFormat('en-IN')` does this correctly and is used elsewhere for
 * display. This exists for the PDF renderer, which needs a plain string with no
 * locale-dependent behaviour — a document must render identically on a
 * developer's Mac and on the VPS, whatever ICU data each happens to carry.
 */
export function formatIndianDigits(value: string | number, decimals = 2): string {
  const money = Money.tryParse(typeof value === 'number' ? String(value) : value);
  if (!money) return '0.00';

  const negative = money.isNegative();
  const fixed = money.abs().round(decimals).toDecimal().toFixed(decimals);
  const [whole = '0', fraction] = fixed.split('.');

  // Last three digits, then groups of two — the defining rule.
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}`
    : lastThree;

  const sign = negative ? '-' : '';
  return fraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`;
}

/**
 * The amount in words, in Indian scale, as printed on a tax invoice.
 *
 * `152400.50` → `Rupees One Lakh Fifty Two Thousand Four Hundred and Fifty Paise Only`
 *
 * Paise are rendered as a whole number of paise, not as a fraction — that is
 * the convention on Indian invoices, and "point five zero" would be wrong.
 */
export function amountInWords(value: string | number, currencyName = 'Rupees'): string {
  const money = Money.tryParse(typeof value === 'number' ? String(value) : value);
  if (!money) return `${currencyName} Zero Only`;

  const negative = money.isNegative();
  const rounded = money.abs().round(2);
  const fixed = rounded.toDecimal().toFixed(2);
  const [wholePart = '0', fractionPart = '00'] = fixed.split('.');

  const whole = Number(wholePart);
  const paise = Number(fractionPart);

  const parts: string[] = [];

  if (whole === 0) {
    parts.push('Zero');
  } else {
    // Indian scale: crore (10^7), lakh (10^5), thousand (10^3), then 0–999.
    const crore = Math.floor(whole / 10_000_000);
    const lakh = Math.floor((whole % 10_000_000) / 100_000);
    const thousand = Math.floor((whole % 100_000) / 1000);
    const remainder = whole % 1000;

    // Crores above 99 are spoken as a plain number of crores — "One Thousand
    // Two Hundred Crore" — rather than inventing a higher scale name.
    if (crore > 0) parts.push(`${toWordsUnder100000(crore)} Crore`);
    if (lakh > 0) parts.push(`${twoDigits(lakh)} Lakh`);
    if (thousand > 0) parts.push(`${threeDigits(thousand)} Thousand`);
    if (remainder > 0) parts.push(threeDigits(remainder));
  }

  let words = `${currencyName} ${parts.join(' ')}`;
  if (paise > 0) words += ` and ${twoDigits(paise)} Paise`;
  if (negative) words = `Minus ${words}`;

  return `${words} Only`.replace(/\s+/g, ' ').trim();
}

/** Handles a crore count that itself runs into lakhs — up to 99,999 crore. */
function toWordsUnder100000(value: number): string {
  if (value < 1000) return threeDigits(value);
  const thousand = Math.floor(value / 1000);
  const rest = value % 1000;
  const parts = [`${threeDigits(thousand)} Thousand`];
  if (rest > 0) parts.push(threeDigits(rest));
  return parts.join(' ');
}
