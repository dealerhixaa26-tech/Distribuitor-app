import { z } from 'zod';
import {
  businessCodeSchema,
  dateOnlySchema,
  dateTimeSchema,
  emailSchema,
  idSchema,
  shortTextSchema,
  tagsSchema,
} from '../primitives/common';
import {
  bankAccountNumberSchema,
  cinSchema,
  gstinSchema,
  ifscSchema,
  indianPhoneSchema,
  panFromGstin,
  panSchema,
  tanSchema,
  udyamSchema,
} from '../primitives/india';
import { positiveMoneySchema } from '../primitives/money';
import { cursorPaginationSchema } from '../primitives/pagination';
import { distributorStatusSchema, distributorTypeSchema } from '../enums';
import { addressSchema } from '../master/geography.schema';

/**
 * Distributor contracts.
 *
 * Statutory identifiers reuse the validators from `primitives/india` — the same
 * ones the GSTIN checksum tests cover — so a distributor's GSTIN is held to
 * exactly the standard the company's own is.
 */

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * The distributor lifecycle, declared as data.
 *
 * Illegal transitions are rejected in one place with one test file, rather than
 * by if-statements scattered through the service. See docs/00 §4.1.
 */
export const DISTRIBUTOR_TRANSITIONS: Readonly<
  Record<z.infer<typeof distributorStatusSchema>, readonly z.infer<typeof distributorStatusSchema>[]>
> = {
  LEAD: ['PENDING_APPROVAL', 'TERMINATED'],
  PENDING_APPROVAL: ['ACTIVE', 'LEAD', 'TERMINATED'],
  ACTIVE: ['SUSPENDED', 'TERMINATED'],
  SUSPENDED: ['ACTIVE', 'TERMINATED'],
  // Terminal. Re-engaging a former partner is a new record, so the history of
  // what they were entitled to under the old agreement stays intact.
  TERMINATED: [],
};

export const canTransitionDistributor = (
  from: z.infer<typeof distributorStatusSchema>,
  to: z.infer<typeof distributorStatusSchema>,
): boolean => DISTRIBUTOR_TRANSITIONS[from].includes(to);

/** Only ACTIVE distributors may transact. Checked by the order service. */
export const canTransact = (status: z.infer<typeof distributorStatusSchema>): boolean =>
  status === 'ACTIVE';

/**
 * KYC required before approval.
 *
 * A GST certificate and PAN are the minimum needed to raise a compliant tax
 * invoice; the signed agreement is what makes the commercial terms enforceable.
 */
export const REQUIRED_KYC_FOR_APPROVAL = ['GST_CERTIFICATE', 'PAN_CARD', 'AGREEMENT'] as const;

// ── Create / update ─────────────────────────────────────────────────────────

const bankingSchema = z.object({
  bankAccountName: shortTextSchema.optional(),
  bankAccountNumber: bankAccountNumberSchema.optional(),
  bankIfsc: ifscSchema.optional(),
  bankName: shortTextSchema.optional(),
});

export const createDistributorSchema = z
  .object({
    legalName: shortTextSchema,
    tradeName: shortTextSchema.optional(),
    type: distributorTypeSchema.default('DISTRIBUTOR'),

    territoryId: idSchema.optional(),
    accountManagerId: idSchema.optional(),

    gstin: gstinSchema.optional(),
    pan: panSchema.optional(),
    tan: tanSchema.optional(),
    cin: cinSchema.optional(),
    msmeNumber: udyamSchema.optional(),

    creditLimit: positiveMoneySchema.default('0'),
    creditDays: z.number().int().min(0).max(365).default(30),
    openingBalance: positiveMoneySchema.default('0'),
    paymentTermsCode: z.string().trim().toUpperCase().max(20).optional(),

    website: z.string().url().max(255).optional().or(z.literal('')),
    tags: tagsSchema,

    billingAddress: addressSchema.optional(),
    shippingAddress: addressSchema.optional(),
  })
  .merge(bankingSchema)
  .refine(
    (data) => {
      // A GSTIN embeds its holder's PAN at characters 3–12. If both are given
      // and they disagree, one of them is a typo — and either way the invoice
      // that results would be wrong.
      if (!data.gstin || !data.pan) return true;
      return panFromGstin(data.gstin) === data.pan;
    },
    {
      message: 'The PAN does not match the one embedded in the GSTIN.',
      path: ['pan'],
    },
  );
export type CreateDistributorDto = z.infer<typeof createDistributorSchema>;

export const updateDistributorSchema = z
  .object({
    legalName: shortTextSchema.optional(),
    tradeName: shortTextSchema.nullable().optional(),
    type: distributorTypeSchema.optional(),
    territoryId: idSchema.nullable().optional(),
    accountManagerId: idSchema.nullable().optional(),
    gstin: gstinSchema.nullable().optional(),
    pan: panSchema.nullable().optional(),
    tan: tanSchema.nullable().optional(),
    cin: cinSchema.nullable().optional(),
    msmeNumber: udyamSchema.nullable().optional(),
    creditDays: z.number().int().min(0).max(365).optional(),
    paymentTermsCode: z.string().trim().toUpperCase().max(20).nullable().optional(),
    website: z.string().url().max(255).nullable().optional().or(z.literal('')),
    tags: tagsSchema.optional(),
    billingAddress: addressSchema.optional(),
    shippingAddress: addressSchema.optional(),
  })
  .merge(bankingSchema.partial());
export type UpdateDistributorDto = z.infer<typeof updateDistributorSchema>;

/**
 * Credit limit changes are a separate endpoint, not part of the general update.
 *
 * The limit is what stands between the company and unrecoverable exposure, so
 * changing it needs its own permission, a mandatory reason, and its own audit
 * trail — not to be buried in a form that also edits a phone number.
 */
export const updateCreditLimitSchema = z.object({
  creditLimit: positiveMoneySchema,
  reason: z.string().trim().min(3, 'A reason is required').max(500),
});

export const transitionDistributorSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const suspendDistributorSchema = z.object({
  reason: z.string().trim().min(3, 'A reason is required').max(500),
});

// ── Contacts ────────────────────────────────────────────────────────────────

export const createContactSchema = z.object({
  name: shortTextSchema,
  designation: z.string().trim().max(120).optional(),
  email: emailSchema.optional(),
  phone: indianPhoneSchema.optional(),
  isPrimary: z.boolean().default(false),
});
export type CreateContactDto = z.infer<typeof createContactSchema>;

// ── KYC ─────────────────────────────────────────────────────────────────────

export const kycDocumentTypeSchema = z.enum([
  'GST_CERTIFICATE',
  'PAN_CARD',
  'AGREEMENT',
  'CANCELLED_CHEQUE',
  'MSME_CERT',
  'OTHER',
]);

export const attachKycSchema = z.object({
  documentId: idSchema,
  type: kycDocumentTypeSchema,
  expiresAt: dateOnlySchema.optional(),
});

export const verifyKycSchema = z.object({
  approved: z.boolean(),
  rejectionReason: z.string().trim().max(500).optional(),
});

// ── Notes & agreements ──────────────────────────────────────────────────────

export const createNoteSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  isPinned: z.boolean().default(false),
});

export const createAgreementSchema = z
  .object({
    reference: z.string().trim().max(60).optional(),
    startDate: dateOnlySchema,
    endDate: dateOnlySchema.optional(),
    targetAmount: positiveMoneySchema.optional(),
    documentId: idSchema.optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((data) => !data.endDate || data.endDate > data.startDate, {
    message: 'The end date must be after the start date.',
    path: ['endDate'],
  });

// ── Read models ─────────────────────────────────────────────────────────────

export const distributorSummarySchema = z.object({
  id: idSchema,
  code: z.string(),
  legalName: z.string(),
  tradeName: z.string().nullable(),
  type: distributorTypeSchema,
  status: distributorStatusSchema,
  gstin: z.string().nullable(),
  pan: z.string().nullable(),
  territoryId: idSchema.nullable(),
  territoryName: z.string().nullable(),
  accountManagerId: idSchema.nullable(),
  accountManagerName: z.string().nullable(),
  creditLimit: z.string(),
  creditDays: z.number().int(),
  /** Masked — the full value needs distributor:update. */
  bankAccountMasked: z.string().nullable(),
  tags: z.array(z.string()),
  onboardedAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
  contactCount: z.number().int().nonnegative(),
  kycVerified: z.boolean(),
  /** KYC types still outstanding before approval is possible. */
  kycMissing: z.array(z.string()),
});
export type DistributorSummary = z.infer<typeof distributorSummarySchema>;

export const listDistributorsQuerySchema = cursorPaginationSchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
    .pipe(z.array(distributorStatusSchema).optional()),
  type: distributorTypeSchema.optional(),
  territoryId: idSchema.optional(),
  accountManagerId: idSchema.optional(),
  sort: z.string().optional(),
});
export type ListDistributorsQuery = z.infer<typeof listDistributorsQuerySchema>;

/** Row shape for the bulk import. */
export const importDistributorRowSchema = z.object({
  legalName: shortTextSchema,
  tradeName: z.string().trim().max(200).optional(),
  gstin: gstinSchema.optional(),
  pan: panSchema.optional(),
  creditLimit: positiveMoneySchema.optional(),
  creditDays: z.coerce.number().int().min(0).max(365).optional(),
  territoryCode: businessCodeSchema.optional(),
  contactName: z.string().trim().max(120).optional(),
  contactEmail: emailSchema.optional(),
  contactPhone: indianPhoneSchema.optional(),
});
export type ImportDistributorRow = z.infer<typeof importDistributorRowSchema>;
