import { z } from 'zod';

/**
 * India-specific identifiers and the validation the GST regime actually
 * requires. These are shared by the API and both frontends so a GSTIN can never
 * be accepted by one and rejected by the other.
 */

// ── GST state codes ─────────────────────────────────────────────────────────

/**
 * The first two characters of a GSTIN. This is not decoration: it is the input
 * to the place-of-supply rule that decides whether a line is taxed CGST+SGST or
 * IGST. See docs/02-data-model.md §7.
 */
export const GST_STATE_CODES = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
  '99': 'Centre Jurisdiction',
} as const;

export type GstStateCode = keyof typeof GST_STATE_CODES;

export const isValidGstStateCode = (code: string): code is GstStateCode =>
  Object.prototype.hasOwnProperty.call(GST_STATE_CODES, code);

/** Hixaa's home state — Nagpur, Maharashtra. The default supplier state. */
export const HIXAA_STATE_CODE: GstStateCode = '27';

// ── GSTIN ───────────────────────────────────────────────────────────────────

/**
 * 15 characters: `27` `AAAAA0000A` `1` `Z` `5`
 *                 └state └PAN       └entity └fixed └checksum
 */
export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Verifies the GSTIN check digit.
 *
 * Worth implementing rather than trusting the regex: a typo in a distributor's
 * GSTIN produces a legally defective invoice that has to be cancelled and
 * reissued via credit note. Catching it at data entry is far cheaper.
 */
export function isValidGstinChecksum(gstin: string): boolean {
  if (gstin.length !== 15) return false;

  const modulus = GSTIN_ALPHABET.length; // 36
  let factor = 2;
  let sum = 0;

  // Walk the first 14 characters right-to-left with alternating weights.
  for (let i = 13; i >= 0; i--) {
    const char = gstin[i];
    if (char === undefined) return false;
    const codePoint = GSTIN_ALPHABET.indexOf(char);
    if (codePoint < 0) return false;

    const product = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    sum += Math.floor(product / modulus) + (product % modulus);
  }

  const expected = GSTIN_ALPHABET[(modulus - (sum % modulus)) % modulus];
  return expected === gstin[14];
}

export function isValidGstin(value: string): boolean {
  const gstin = value.toUpperCase().trim();
  if (!GSTIN_REGEX.test(gstin)) return false;
  if (!isValidGstStateCode(gstin.slice(0, 2))) return false;
  return isValidGstinChecksum(gstin);
}

/** Extracts the embedded PAN — characters 3–12 of a GSTIN. */
export const panFromGstin = (gstin: string): string => gstin.toUpperCase().slice(2, 12);

/** Extracts the state code — characters 1–2 of a GSTIN. */
export const stateCodeFromGstin = (gstin: string): string => gstin.slice(0, 2);

export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(15, 'A GSTIN is exactly 15 characters')
  .refine((v) => GSTIN_REGEX.test(v), 'Malformed GSTIN, expected e.g. 27AAAAA0000A1Z5')
  .refine(
    (v) => isValidGstStateCode(v.slice(0, 2)),
    (v) => ({ message: `"${v.slice(0, 2)}" is not a valid GST state code` }),
  )
  .refine(isValidGstinChecksum, 'GSTIN check digit is incorrect — please re-check the number')
  .describe('15-character GST Identification Number');

// ── PAN ─────────────────────────────────────────────────────────────────────

/**
 * `AAAAA0000A`. The 4th character encodes the holder type, which lets us catch
 * an individual's PAN being entered for a company.
 */
export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const PAN_HOLDER_TYPES = {
  P: 'Individual',
  C: 'Company',
  H: 'Hindu Undivided Family',
  F: 'Firm / LLP',
  A: 'Association of Persons',
  T: 'Trust',
  B: 'Body of Individuals',
  L: 'Local Authority',
  J: 'Artificial Juridical Person',
  G: 'Government',
} as const;

export type PanHolderType = keyof typeof PAN_HOLDER_TYPES;

export const panHolderType = (pan: string): string | undefined => {
  const code = pan.toUpperCase()[3] as PanHolderType | undefined;
  return code ? PAN_HOLDER_TYPES[code] : undefined;
};

export const isValidPan = (value: string): boolean => {
  const pan = value.toUpperCase().trim();
  if (!PAN_REGEX.test(pan)) return false;
  const holder = pan[3];
  return holder !== undefined && holder in PAN_HOLDER_TYPES;
};

export const panSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(10, 'A PAN is exactly 10 characters')
  .refine((v) => PAN_REGEX.test(v), 'Malformed PAN, expected e.g. AAAAA0000A')
  .refine(
    (v) => (v[3] ?? '') in PAN_HOLDER_TYPES,
    'The 4th character of a PAN must be a valid holder-type code',
  )
  .describe('10-character Permanent Account Number');

// ── HSN / SAC ───────────────────────────────────────────────────────────────

/** HSN classifies GOODS. Valid lengths are 4, 6, or 8 digits. */
export const HSN_REGEX = /^\d{4}(\d{2})?(\d{2})?$/;

/** SAC classifies SERVICES and always begins with 99. */
export const SAC_REGEX = /^99\d{4}$/;

export const hsnSchema = z
  .string()
  .trim()
  .regex(HSN_REGEX, 'HSN must be 4, 6, or 8 digits')
  .describe('Harmonised System of Nomenclature code for goods');

export const sacSchema = z
  .string()
  .trim()
  .regex(SAC_REGEX, 'SAC must be 6 digits beginning with 99')
  .describe('Services Accounting Code');

/** Accepts either, for products whose type is not yet known. */
export const hsnOrSacSchema = z
  .string()
  .trim()
  .refine((v) => HSN_REGEX.test(v) || SAC_REGEX.test(v), 'Must be a valid HSN or SAC code');

/** GST slabs currently in force. Rates are still stored date-effectively in the DB. */
export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28] as const;
export type GstRate = (typeof GST_RATES)[number];

export const gstRateSchema = z
  .number()
  .refine(
    (v) => (GST_RATES as readonly number[]).includes(v),
    `GST rate must be one of: ${GST_RATES.join(', ')}`,
  );

// ── Banking ─────────────────────────────────────────────────────────────────

/** `HDFC0001234` — 4 letters, a mandatory 0, then 6 alphanumerics. */
export const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export const ifscSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(IFSC_REGEX, 'Malformed IFSC, expected e.g. HDFC0001234')
  .describe('Indian Financial System Code');

export const bankAccountNumberSchema = z
  .string()
  .trim()
  .regex(/^\d{9,18}$/, 'Bank account number must be 9–18 digits');

// ── Contact & address ───────────────────────────────────────────────────────

/** Accepts `9876543210`, `+919876543210`, `09876543210`; normalises to +91XXXXXXXXXX. */
export const indianPhoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-()]/g, ''))
  .refine((v) => /^(\+91|91|0)?[6-9]\d{9}$/.test(v), 'Must be a valid Indian mobile number')
  .transform((v) => `+91${v.replace(/^(\+91|91|0)/, '')}`)
  .describe('Indian mobile number, normalised to +91XXXXXXXXXX');

export const pincodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, 'PIN code must be 6 digits and cannot start with 0');

// ── Other statutory identifiers ─────────────────────────────────────────────

/** Corporate Identification Number — 21 characters. */
export const cinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[LUu]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/, 'Malformed CIN');

/** Tax Deduction Account Number — `NGPH12345A`. */
export const tanSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{4}\d{5}[A-Z]$/, 'Malformed TAN, expected e.g. NGPH12345A');

/** Udyam registration number for MSME classification. */
export const udyamSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/, 'Malformed Udyam number, expected UDYAM-MH-00-0000000');

// ── Financial year ──────────────────────────────────────────────────────────

/** Indian FY runs 1 April – 31 March. Invoice series reset on this boundary. */
export const FINANCIAL_YEAR_START_MONTH = 4;

/** Returns the FY label for a date, e.g. `2026-27`. */
export function financialYearOf(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const startYear = month >= FINANCIAL_YEAR_START_MONTH ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export const financialYearSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Financial year must look like 2026-27');
