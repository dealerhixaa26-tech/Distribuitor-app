import { describe, expect, it } from 'vitest';
import { amountInWords, formatIndianDigits } from '../indian-number';

/**
 * Indian grouping and amount-in-words.
 *
 * Both appear on a GST tax invoice, so an error here is a defective legal
 * document rather than a cosmetic slip. The cases below are the ones that
 * actually break naive implementations: the lakh/crore boundaries, the
 * irregular teens, and the zero-in-the-middle case.
 */

describe('formatIndianDigits — last three, then twos', () => {
  it.each([
    ['0', '0.00'],
    ['1', '1.00'],
    ['999', '999.00'],
    ['1000', '1,000.00'],
    ['99999', '99,999.00'],
    // The boundary where Indian grouping diverges from western.
    ['100000', '1,00,000.00'],
    ['1234567', '12,34,567.00'],
    ['12345678', '1,23,45,678.00'],
    ['123456789', '12,34,56,789.00'],
  ])('groups %s as %s', (input, expected) => {
    expect(formatIndianDigits(input)).toBe(expected);
  });

  it('is NOT the western thousands pattern', () => {
    // 12,345,678 would be wrong on an Indian invoice.
    expect(formatIndianDigits('12345678')).toBe('1,23,45,678.00');
    expect(formatIndianDigits('12345678')).not.toContain('12,345,678');
  });

  it('keeps paise', () => {
    expect(formatIndianDigits('152400.50')).toBe('1,52,400.50');
    expect(formatIndianDigits('0.05')).toBe('0.05');
  });

  it('rounds half-up to the requested scale', () => {
    expect(formatIndianDigits('1.005', 2)).toBe('1.01');
  });

  it('handles a negative amount', () => {
    expect(formatIndianDigits('-1234567.89')).toBe('-12,34,567.89');
  });

  it('returns a safe default for unparseable input', () => {
    expect(formatIndianDigits('not a number')).toBe('0.00');
  });
});

describe('amountInWords — the Indian scale', () => {
  it.each([
    ['0', 'Rupees Zero Only'],
    ['1', 'Rupees One Only'],
    ['15', 'Rupees Fifteen Only'],
    ['20', 'Rupees Twenty Only'],
    ['21', 'Rupees Twenty One Only'],
    ['100', 'Rupees One Hundred Only'],
    ['999', 'Rupees Nine Hundred Ninety Nine Only'],
    ['1000', 'Rupees One Thousand Only'],
    ['100000', 'Rupees One Lakh Only'],
    ['10000000', 'Rupees One Crore Only'],
  ])('renders %s', (input, expected) => {
    expect(amountInWords(input)).toBe(expected);
  });

  it('never says "million" — that scale does not exist here', () => {
    const words = amountInWords('12345678');
    expect(words).not.toContain('Million');
    expect(words).toContain('Crore');
    expect(words).toContain('Lakh');
  });

  it('renders a realistic invoice total', () => {
    // A Raksha 50-worker deployment, GST inclusive.
    expect(amountInWords('875560')).toBe(
      'Rupees Eight Lakh Seventy Five Thousand Five Hundred Sixty Only',
    );
  });

  it('renders paise as whole paise, not as a fraction', () => {
    expect(amountInWords('152400.50')).toBe(
      'Rupees One Lakh Fifty Two Thousand Four Hundred and Fifty Paise Only',
    );
  });

  it('handles a single paisa', () => {
    expect(amountInWords('0.01')).toBe('Rupees Zero and One Paise Only');
  });

  it('skips a zero group rather than emitting an empty word', () => {
    // 1,00,00,500 — crore and hundreds present, lakh and thousand absent.
    expect(amountInWords('10000500')).toBe('Rupees One Crore Five Hundred Only');
  });

  it('handles the teens, which are irregular', () => {
    expect(amountInWords('11')).toBe('Rupees Eleven Only');
    expect(amountInWords('19')).toBe('Rupees Nineteen Only');
    expect(amountInWords('1100')).toBe('Rupees One Thousand One Hundred Only');
  });

  it('handles a crore count that itself runs into thousands', () => {
    // 1,200 crore — spoken as a number of crores, not a new scale name.
    expect(amountInWords('12000000000')).toBe('Rupees One Thousand Two Hundred Crore Only');
  });

  it('marks a negative amount', () => {
    expect(amountInWords('-500')).toBe('Minus Rupees Five Hundred Only');
  });

  it('accepts an alternative currency name', () => {
    expect(amountInWords('100', 'US Dollars')).toBe('US Dollars One Hundred Only');
  });

  it('never emits double spaces', () => {
    for (const amount of ['10000500', '100000000', '1000000', '20000000']) {
      expect(amountInWords(amount)).not.toMatch(/ {2}/);
    }
  });

  it('rounds to two decimals before spelling', () => {
    expect(amountInWords('99.999')).toBe('Rupees One Hundred Only');
  });
});
