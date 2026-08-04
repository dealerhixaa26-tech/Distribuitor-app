import { describe, expect, it } from 'vitest';
import {
  financialYearOf,
  gstinSchema,
  indianPhoneSchema,
  isValidGstin,
  isValidGstinChecksum,
  isValidPan,
  panFromGstin,
  panSchema,
  stateCodeFromGstin,
  hsnSchema,
  sacSchema,
  ifscSchema,
} from '../india';

describe('GSTIN', () => {
  // Two publicly-listed, real GSTINs used purely as checksum fixtures.
  const VALID = ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4'];

  it.each(VALID)('accepts the real GSTIN %s', (gstin) => {
    expect(isValidGstin(gstin)).toBe(true);
    expect(gstinSchema.safeParse(gstin).success).toBe(true);
  });

  it('rejects a GSTIN whose check digit is wrong', () => {
    // Correct format, correct state code, single wrong final character.
    expect(isValidGstinChecksum('27AAPFU0939F1ZX')).toBe(false);
    expect(isValidGstin('27AAPFU0939F1ZX')).toBe(false);
  });

  it('rejects an unknown state code even when the format is right', () => {
    // 28 was Andhra Pradesh pre-bifurcation and is no longer allocated.
    const result = gstinSchema.safeParse('28AAPFU0939F1ZV');
    expect(result.success).toBe(false);
  });

  it('rejects malformed lengths and shapes', () => {
    for (const bad of ['', '27AAPFU0939F1Z', '27AAPFU0939F1ZVV', '2AAPFU0939F1ZVX', 'AAAAAAAAAAAAAAA']) {
      expect(gstinSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('normalises case before validating', () => {
    expect(gstinSchema.parse('27aapfu0939f1zv')).toBe('27AAPFU0939F1ZV');
  });

  it('extracts the embedded PAN and state code', () => {
    expect(panFromGstin('27AAPFU0939F1ZV')).toBe('AAPFU0939F');
    expect(stateCodeFromGstin('27AAPFU0939F1ZV')).toBe('27');
    // The embedded PAN must itself be a valid PAN — a useful cross-check.
    expect(isValidPan(panFromGstin('27AAPFU0939F1ZV'))).toBe(true);
  });
});

describe('PAN', () => {
  it('accepts well-formed PANs with a valid holder-type character', () => {
    expect(isValidPan('AAPFU0939F')).toBe(true);
    expect(panSchema.parse('aapfu0939f')).toBe('AAPFU0939F');
  });

  it('rejects an invalid holder-type character in position 4', () => {
    // 'X' is not an allocated holder type.
    expect(isValidPan('AAPXU0939F')).toBe(false);
  });

  it('rejects malformed PANs', () => {
    for (const bad of ['AAPFU0939', 'AAPFU09399', '12345678AB', '']) {
      expect(panSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('HSN / SAC', () => {
  it('accepts HSN codes of 4, 6, and 8 digits', () => {
    for (const code of ['8537', '853710', '85371000']) {
      expect(hsnSchema.safeParse(code).success).toBe(true);
    }
  });

  it('rejects HSN codes of other lengths', () => {
    for (const code of ['853', '85371', '8537100', '853710000']) {
      expect(hsnSchema.safeParse(code).success).toBe(false);
    }
  });

  it('requires SAC codes to be 6 digits beginning with 99', () => {
    expect(sacSchema.safeParse('998719').success).toBe(true);
    expect(sacSchema.safeParse('123456').success).toBe(false);
    expect(sacSchema.safeParse('99871').success).toBe(false);
  });
});

describe('IFSC', () => {
  it('accepts a valid IFSC and rejects one missing the mandatory 0', () => {
    expect(ifscSchema.safeParse('HDFC0001234').success).toBe(true);
    expect(ifscSchema.safeParse('HDFC1001234').success).toBe(false);
  });
});

describe('Indian mobile numbers', () => {
  it('normalises every accepted form to +91XXXXXXXXXX', () => {
    for (const input of ['9876543210', '+919876543210', '09876543210', '+91 98765 43210']) {
      expect(indianPhoneSchema.parse(input)).toBe('+919876543210');
    }
  });

  it('rejects numbers that do not start 6–9', () => {
    expect(indianPhoneSchema.safeParse('5876543210').success).toBe(false);
    expect(indianPhoneSchema.safeParse('98765').success).toBe(false);
  });
});

describe('financial year', () => {
  it('rolls over on 1 April, not 1 January', () => {
    expect(financialYearOf(new Date('2026-03-31T00:00:00Z'))).toBe('2025-26');
    expect(financialYearOf(new Date('2026-04-01T00:00:00Z'))).toBe('2026-27');
    expect(financialYearOf(new Date('2026-12-31T00:00:00Z'))).toBe('2026-27');
    expect(financialYearOf(new Date('2027-01-01T00:00:00Z'))).toBe('2026-27');
  });
});
