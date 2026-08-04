import { z } from 'zod';
import { emailSchema, idSchema } from '../primitives/common';
import { gstinSchema, panSchema, pincodeSchema } from '../primitives/india';

/**
 * System settings.
 *
 * This is how "nothing about the company is hardcoded" is honoured: company
 * identity, statutory numbers, branding, and finance defaults all live as data
 * and are editable from the Admin Panel.
 *
 * Each category has its own schema so a settings write is validated as strictly
 * as any other DTO — a malformed GSTIN saved here would propagate onto every
 * invoice the system issues.
 */

export const SETTING_CATEGORIES = [
  'company',
  'branding',
  'portfolio',
  'finance',
  'approvals',
] as const;
export type SettingCategory = (typeof SETTING_CATEGORIES)[number];

export const settingCategorySchema = z.enum(SETTING_CATEGORIES);

// ── company ─────────────────────────────────────────────────────────────────

export const companyProfileSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().min(1).max(120),
  tagline: z.string().trim().max(200).optional(),
  secondaryTagline: z.string().trim().max(200).optional(),
  website: z.string().url().max(255).optional().or(z.literal('')),
  email: emailSchema,
  phones: z.array(z.string().trim().min(6).max(20)).max(5).default([]),
  linkedin: z.string().url().max(255).optional().or(z.literal('')),
});

export const companyStatutorySchema = z.object({
  gstin: gstinSchema,
  pan: panSchema,
  stateCode: z.string().length(2),
  cin: z.string().trim().max(21).optional().or(z.literal('')),
  /**
   * Set once a human has confirmed the statutory numbers are real.
   *
   * The invoicing module refuses to issue while this is false, so a
   * placeholder GSTIN cannot silently produce legally defective documents.
   */
  verified: z.boolean().default(false),
});

export const companyAddressSchema = z.object({
  line1: z.string().trim().min(2).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().min(1).max(80),
  stateCode: z.string().length(2),
  postalCode: pincodeSchema,
  country: z.string().trim().default('India'),
});

// ── branding ────────────────────────────────────────────────────────────────

const hexColour = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a 6-digit hex colour, e.g. #0057B8');

export const brandingThemeSchema = z.object({
  primary: hexColour,
  primaryDark: hexColour,
  logoDocumentId: idSchema.nullable().default(null),
  logoDarkDocumentId: idSchema.nullable().default(null),
  faviconDocumentId: idSchema.nullable().default(null),
});

// ── finance ─────────────────────────────────────────────────────────────────

export const financeDefaultsSchema = z.object({
  currency: z.string().length(3).default('INR'),
  financialYearStartMonth: z.number().int().min(1).max(12).default(4),
  invoicePrefix: z.string().trim().min(1).max(20),
  orderPrefix: z.string().trim().min(1).max(20),
  roundInvoiceToWholeRupee: z.boolean().default(true),
});

export const paymentTermsSchema = z.array(
  z.object({
    code: z.string().trim().toUpperCase().min(2).max(20),
    name: z.string().trim().min(2).max(60),
    days: z.number().int().min(0).max(365),
  }),
);

// ── approvals ───────────────────────────────────────────────────────────────

export const approvalCeilingsSchema = z.object({
  escalateWhenExceeded: z.boolean().default(true),
  /** Applies regardless of permissions — see docs/04-rbac §3. */
  preventSelfApproval: z.boolean().default(true),
  requireReasonOnOverride: z.boolean().default(true),
});

// ── Registry ────────────────────────────────────────────────────────────────

/**
 * Maps `category.key` to its validator.
 *
 * A write to an unregistered key is rejected: settings are a structured
 * configuration surface, not a JSON dumping ground that later code has to
 * defensively parse.
 */
export const SETTING_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'company.profile': companyProfileSchema,
  'company.statutory': companyStatutorySchema,
  'company.registeredAddress': companyAddressSchema,
  'branding.theme': brandingThemeSchema,
  'finance.defaults': financeDefaultsSchema,
  'finance.paymentTerms': paymentTermsSchema,
  'approvals.ceilings': approvalCeilingsSchema,
};

export const settingKey = (category: string, key: string): string => `${category}.${key}`;

export const isWritableSetting = (category: string, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(SETTING_SCHEMAS, settingKey(category, key));

export const updateSettingSchema = z.object({
  value: z.unknown(),
});

export const settingEntrySchema = z.object({
  category: z.string(),
  key: z.string(),
  value: z.unknown(),
  description: z.string().nullable(),
  isSecret: z.boolean(),
  /** False for read-only seeded content such as the portfolio catalogue. */
  writable: z.boolean(),
  updatedAt: z.string(),
});
export type SettingEntry = z.infer<typeof settingEntrySchema>;
