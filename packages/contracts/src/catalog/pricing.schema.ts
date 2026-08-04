import { z } from 'zod';
import {
  businessCodeSchema,
  dateOnlySchema,
  dateTimeSchema,
  idSchema,
  mediumTextSchema,
  shortTextSchema,
} from '../primitives/common';
import { gstRateSchema, hsnOrSacSchema } from '../primitives/india';
import { moneySchema, percentSchema, positiveMoneySchema, quantitySchema } from '../primitives/money';
import { cursorPaginationSchema } from '../primitives/pagination';
import {
  discountScopeSchema,
  discountTypeSchema,
  priceBasisSchema,
  priceListStatusSchema,
  type PriceListStatus,
} from '../enums';

/**
 * Price list, discount rule, tax rate, and the pricing quote contracts.
 *
 * All prices here are GST-EXCLUSIVE (ADR-0008). Every money value crosses the
 * wire as a string (ADR-0004) — a JSON number would silently alter large
 * amounts, and these are the numbers that end up on tax invoices.
 */

// ── Price lists ─────────────────────────────────────────────────────────────

export const PRICE_LIST_TRANSITIONS: Readonly<
  Record<PriceListStatus, readonly PriceListStatus[]>
> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['ARCHIVED'],
  // Terminal. A published list is never edited back into draft: orders were
  // negotiated against it, and reopening it would silently reprice them.
  // The way forward is to clone it.
  ARCHIVED: [],
};

export const canTransitionPriceList = (from: PriceListStatus, to: PriceListStatus): boolean =>
  PRICE_LIST_TRANSITIONS[from].includes(to);

export const createPriceListSchema = z
  .object({
    code: businessCodeSchema,
    name: shortTextSchema,
    currency: z.string().length(3).toUpperCase().default('INR'),
    priceBasis: priceBasisSchema.default('EXCLUSIVE'),
    validFrom: dateOnlySchema,
    validTo: dateOnlySchema.optional(),
    isDefault: z.boolean().default(false),
    description: mediumTextSchema.optional(),
  })
  .refine((v) => !v.validTo || v.validTo >= v.validFrom, {
    path: ['validTo'],
    message: 'The end date cannot precede the start date',
  });

export type CreatePriceListDto = z.infer<typeof createPriceListSchema>;

export const updatePriceListSchema = z.object({
  name: shortTextSchema.optional(),
  validFrom: dateOnlySchema.optional(),
  validTo: dateOnlySchema.nullable().optional(),
  isDefault: z.boolean().optional(),
  description: mediumTextSchema.optional(),
});

export type UpdatePriceListDto = z.infer<typeof updatePriceListSchema>;

export const clonePriceListSchema = z.object({
  code: businessCodeSchema,
  name: shortTextSchema,
  validFrom: dateOnlySchema,
  validTo: dateOnlySchema.optional(),
  /** Applies a blanket uplift or reduction to every copied price. */
  adjustPercent: percentSchema.optional(),
});

export type ClonePriceListDto = z.infer<typeof clonePriceListSchema>;

/**
 * One volume slab. `minQty` is the slab's inclusive lower bound: rows at
 * 1 / 10 / 50 for one product are three slabs.
 */
export const priceListItemSchema = z.object({
  productId: idSchema,
  variantId: idSchema.optional(),
  minQty: quantitySchema.default('1'),
  /** GST-exclusive unit price. */
  price: positiveMoneySchema,
  /** Below this, an override is flagged for approval regardless of role. */
  minPrice: positiveMoneySchema.optional(),
});

export type PriceListItemDto = z.infer<typeof priceListItemSchema>;

export const upsertPriceListItemsSchema = z.object({
  items: z.array(priceListItemSchema).min(1).max(1000),
  /** Replaces the list's entire contents rather than merging. */
  replaceAll: z.boolean().default(false),
});

export const listPriceListsQuerySchema = cursorPaginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  status: priceListStatusSchema.optional(),
  activeOn: dateOnlySchema.optional(),
});

export type ListPriceListsQuery = z.infer<typeof listPriceListsQuerySchema>;

// ── Discount rules ──────────────────────────────────────────────────────────

export const createDiscountRuleSchema = z
  .object({
    code: businessCodeSchema,
    name: shortTextSchema,
    scope: discountScopeSchema.default('GLOBAL'),
    targetId: idSchema.optional(),
    type: discountTypeSchema.default('PERCENT'),
    value: positiveMoneySchema,
    minQty: quantitySchema.optional(),
    minAmount: positiveMoneySchema.optional(),
    maxDiscountAmount: positiveMoneySchema.optional(),
    /** Lower wins. Ties break on scope specificity. */
    priority: z.number().int().min(0).max(9999).default(100),
    validFrom: dateOnlySchema,
    validTo: dateOnlySchema.optional(),
    isActive: z.boolean().default(true),
    description: mediumTextSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // GLOBAL is the only scope without a target; every other scope names
    // something. Mirrors the CHECK constraint in migration 0006.
    if (value.scope === 'GLOBAL' && value.targetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetId'],
        message: 'A GLOBAL rule applies everywhere and cannot name a target',
      });
    }
    if (value.scope !== 'GLOBAL' && !value.targetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetId'],
        message: `A ${value.scope} rule must name the ${value.scope.toLowerCase()} it applies to`,
      });
    }
    if (value.type === 'PERCENT' && Number(value.value) > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'A percentage discount above 100% would pay the customer',
      });
    }
    if (value.validTo && value.validTo < value.validFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validTo'],
        message: 'The end date cannot precede the start date',
      });
    }
  });

export type CreateDiscountRuleDto = z.infer<typeof createDiscountRuleSchema>;

export const listDiscountRulesQuerySchema = cursorPaginationSchema.extend({
  scope: discountScopeSchema.optional(),
  targetId: idSchema.optional(),
  isActive: z.coerce.boolean().optional(),
  activeOn: dateOnlySchema.optional(),
});

// ── Tax rates ───────────────────────────────────────────────────────────────

export const createTaxRateSchema = z.object({
  hsnSacCode: hsnOrSacSchema,
  gstRate: gstRateSchema,
  cessRate: z.number().min(0).max(100).default(0),
  effectiveFrom: dateOnlySchema,
  description: shortTextSchema.optional(),
});

export type CreateTaxRateDto = z.infer<typeof createTaxRateSchema>;

export const listTaxRatesQuerySchema = cursorPaginationSchema.extend({
  hsnSacCode: z.string().trim().max(8).optional(),
  effectiveOn: dateOnlySchema.optional(),
});

// ── The quote request (ADR-0007) ────────────────────────────────────────────

/**
 * A manual price override — the mechanism that makes pricing situational.
 *
 * `reason` is mandatory and deliberately not defaulted: an unexplained price
 * concession is indistinguishable from a data-entry error six months later,
 * when the only person who could explain it has left.
 */
export const priceOverrideSchema = z.object({
  unitPrice: positiveMoneySchema,
  reason: z.string().trim().min(10, 'Explain the override in at least a few words').max(500),
});

export type PriceOverrideDto = z.infer<typeof priceOverrideSchema>;

export const quoteLineRequestSchema = z.object({
  productId: idSchema,
  variantId: idSchema.optional(),
  quantity: quantitySchema,
  override: priceOverrideSchema.optional(),
  /** Suppresses discount rules for this line — used when re-pricing an order
   *  whose discount was already agreed and must not be re-derived. */
  skipDiscounts: z.boolean().default(false),
});

export const quoteRequestSchema = z.object({
  /** Drives price-list selection and the default place of supply. */
  distributorId: idSchema.optional(),
  /** Overrides the distributor's assigned list — used for what-if pricing. */
  priceListId: idSchema.optional(),
  /** The date the pricing and tax rates are resolved against. Defaults to today. */
  asOf: dateOnlySchema.optional(),
  /**
   * GST state code of the delivery destination. Decides CGST+SGST versus IGST.
   * Defaults to the distributor's GSTIN state.
   */
  placeOfSupplyStateCode: z.string().regex(/^\d{2}$/, 'A two-digit GST state code').optional(),
  lines: z.array(quoteLineRequestSchema).min(1).max(200),
  /** Set false to omit the per-line resolution trace from the response. */
  includeTrace: z.boolean().default(true),
});

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;
export type QuoteLineRequest = z.infer<typeof quoteLineRequestSchema>;

// ── The quote response ──────────────────────────────────────────────────────

/** Why a discount rule did or did not apply. */
export interface DiscountCandidate {
  ruleId: string;
  code: string;
  name: string;
  scope: z.infer<typeof discountScopeSchema>;
  type: z.infer<typeof discountTypeSchema>;
  value: string;
  priority: number;
  applied: boolean;
  /** Populated only when `applied` is false. */
  rejectedBecause?: string;
}

export interface QuoteLineTrace {
  priceListId: string;
  priceListCode: string;
  /** Why this list rather than another. */
  priceListReason: 'EXPLICIT' | 'DISTRIBUTOR_CUSTOM' | 'DISTRIBUTOR_ASSIGNED' | 'DEFAULT';
  /** The slab's lower bound, or null when only a flat price exists. */
  matchedSlabMinQty: string | null;
  listPrice: string;
  discountCandidates: DiscountCandidate[];
  taxRateId: string | null;
  taxRateSource: 'TAX_RATE_TABLE' | 'PRODUCT_SNAPSHOT';
}

export interface QuoteLineResult {
  productId: string;
  variantId: string | null;
  sku: string;
  name: string;
  quantity: string;

  /** Before any discount or override. */
  listUnitPrice: string;
  /** After discount and override — what the invoice line will carry. */
  unitPrice: string;
  discountAmount: string;
  discountPercent: string;

  /** quantity × unitPrice, the GST-exclusive line value. */
  taxableValue: string;

  hsnSacCode: string | null;
  gstRate: string;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
  totalTax: string;
  lineTotal: string;

  isOverridden: boolean;
  overrideReason: string | null;
  /** Discount implied by the override, measured against the list price. */
  effectiveDiscountPercent: string;
  /**
   * True when the override exceeds the caller's role ceiling or the slab's
   * price floor. The engine FLAGS but never refuses — enforcement belongs to
   * order approval in Phase 7, which is what can actually block a commitment.
   */
  requiresApproval: boolean;
  approvalReasons: string[];

  trace: QuoteLineTrace | null;
}

export interface QuoteResult {
  asOf: string;
  currency: string;
  placeOfSupplyStateCode: string;
  supplierStateCode: string;
  /** True when supplier and place of supply differ — IGST rather than CGST+SGST. */
  isInterState: boolean;

  lines: QuoteLineResult[];

  subtotal: string;
  totalDiscount: string;
  taxableValue: string;
  totalCgst: string;
  totalSgst: string;
  totalIgst: string;
  totalCess: string;
  totalTax: string;
  /** Residual that makes the grand total a whole rupee. */
  roundOff: string;
  grandTotal: string;

  requiresApproval: boolean;
  approvalReasons: string[];
}

// ── Authorized catalog ──────────────────────────────────────────────────────

export const authorizeProductSchema = z.object({
  productId: idSchema,
  customPriceListId: idSchema.optional(),
  maxOrderQty: quantitySchema.optional(),
  notes: mediumTextSchema.optional(),
});

export type AuthorizeProductDto = z.infer<typeof authorizeProductSchema>;

export const bulkAuthorizeProductsSchema = z.object({
  productIds: z.array(idSchema).min(1).max(500),
  customPriceListId: idSchema.optional(),
});

export const listAuthorizedProductsQuerySchema = cursorPaginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  isActive: z.coerce.boolean().optional(),
});

// ── Response shapes ─────────────────────────────────────────────────────────

export const priceListSummarySchema = z.object({
  id: idSchema,
  code: z.string(),
  name: z.string(),
  status: priceListStatusSchema,
  currency: z.string(),
  priceBasis: priceBasisSchema,
  validFrom: z.string(),
  validTo: z.string().nullable(),
  isDefault: z.boolean(),
  version: z.number().int(),
  clonedFromId: idSchema.nullable(),
  itemCount: z.number().int().nonnegative(),
  distributorCount: z.number().int().nonnegative(),
  publishedAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
});

export type PriceListSummary = z.infer<typeof priceListSummarySchema>;

export const discountRuleSummarySchema = z.object({
  id: idSchema,
  code: z.string(),
  name: z.string(),
  scope: discountScopeSchema,
  targetId: idSchema.nullable(),
  targetName: z.string().nullable(),
  type: discountTypeSchema,
  value: z.string(),
  minQty: z.string().nullable(),
  minAmount: z.string().nullable(),
  maxDiscountAmount: z.string().nullable(),
  priority: z.number().int(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: dateTimeSchema,
});

export type DiscountRuleSummary = z.infer<typeof discountRuleSummarySchema>;

export const taxRateSummarySchema = z.object({
  id: idSchema,
  hsnSacCode: z.string(),
  gstRate: z.string(),
  cessRate: z.string(),
  description: z.string().nullable(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  createdAt: dateTimeSchema,
});

export type TaxRateSummary = z.infer<typeof taxRateSummarySchema>;

/** Re-exported so consumers need not reach into primitives for the common case. */
export { moneySchema };
