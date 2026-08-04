import { z } from 'zod';
import {
  businessCodeSchema,
  dateTimeSchema,
  idSchema,
  longTextSchema,
  mediumTextSchema,
  shortTextSchema,
  slugSchema,
  tagsSchema,
} from '../primitives/common';
import { gstRateSchema, hsnSchema, sacSchema } from '../primitives/india';
import { quantitySchema } from '../primitives/money';
import { cursorPaginationSchema } from '../primitives/pagination';
import {
  productMediaTypeSchema,
  productStatusSchema,
  productTypeSchema,
  type ProductStatus,
} from '../enums';

/**
 * Product contracts.
 *
 * The tax-classification rule — HSN for goods, SAC for services, exactly one —
 * is enforced in three places on purpose: here (so a bad request is rejected
 * before it reaches a service), in the service (so an internal caller cannot
 * bypass it), and as a CHECK constraint in migration 0006 (so neither can a
 * psql session). A service invoiced under an HSN code is a GST filing defect,
 * and it surfaces at return time, months after the invoice reached the buyer.
 */

// ── Lifecycle ───────────────────────────────────────────────────────────────

export const PRODUCT_TRANSITIONS: Readonly<Record<ProductStatus, readonly ProductStatus[]>> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['DISCONTINUED', 'ARCHIVED'],
  // Discontinued products stay orderable against existing stock, so the way
  // back to ACTIVE stays open.
  DISCONTINUED: ['ACTIVE', 'ARCHIVED'],
  // Terminal. Archived products remain referenced by historical order lines,
  // which is exactly why they are archived rather than deleted.
  ARCHIVED: [],
};

export const canTransitionProduct = (from: ProductStatus, to: ProductStatus): boolean =>
  PRODUCT_TRANSITIONS[from].includes(to);

/** Only these may be added to a quotation or an order. */
export const SELLABLE_PRODUCT_STATUSES: readonly ProductStatus[] = ['ACTIVE', 'DISCONTINUED'];

// ── Specifications ──────────────────────────────────────────────────────────

export const productSpecificationSchema = z.object({
  groupName: shortTextSchema.optional(),
  name: shortTextSchema,
  value: shortTextSchema,
  unit: z.string().trim().max(30).optional(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

export type ProductSpecificationDto = z.infer<typeof productSpecificationSchema>;

// ── Create / update ─────────────────────────────────────────────────────────

const productBaseSchema = z.object({
  sku: businessCodeSchema,
  name: shortTextSchema,
  slug: slugSchema.optional(),
  type: productTypeSchema.default('GOODS'),

  categoryId: idSchema.optional(),
  brandId: idSchema.optional(),
  uomId: idSchema.optional(),

  shortDescription: mediumTextSchema.optional(),
  description: longTextSchema.optional(),

  hsnCode: hsnSchema.optional(),
  sacCode: sacSchema.optional(),
  gstRate: gstRateSchema.default(18),

  isSerialized: z.boolean().default(false),
  isBatchTracked: z.boolean().default(false),
  isReturnable: z.boolean().default(true),
  isPurchasable: z.boolean().default(true),
  isSellable: z.boolean().default(true),

  warrantyMonths: z.number().int().min(0).max(600).optional(),
  leadTimeDays: z.number().int().min(0).max(3650).optional(),
  minOrderQty: quantitySchema.default('1'),
  weightGrams: quantitySchema.optional(),

  tags: tagsSchema,
  specifications: z.array(productSpecificationSchema).max(200).default([]),
});

/**
 * A product is classified by HSN **or** SAC, never both.
 *
 * Applied as a superRefine rather than a union so the error attaches to the
 * offending field and React Hook Form can render it next to the input, instead
 * of reporting "no union member matched" at the form root.
 */
const assertTaxClassification = (
  value: { type?: string; hsnCode?: string; sacCode?: string },
  ctx: z.RefinementCtx,
): void => {
  if (value.hsnCode && value.sacCode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sacCode'],
      message: 'A product carries an HSN or a SAC code, not both',
    });
  }

  if (value.type === 'SERVICE' && value.hsnCode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['hsnCode'],
      message: 'Services are classified by SAC, not HSN',
    });
  }

  if (value.type && value.type !== 'SERVICE' && value.sacCode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sacCode'],
      message: 'Only SERVICE products are classified by SAC',
    });
  }
};

export const createProductSchema = productBaseSchema.superRefine(assertTaxClassification);

export type CreateProductDto = z.infer<typeof createProductSchema>;

export const updateProductSchema = productBaseSchema
  .partial()
  .omit({ sku: true, specifications: true })
  .superRefine(assertTaxClassification);

export type UpdateProductDto = z.infer<typeof updateProductSchema>;

export const changeProductStatusSchema = z.object({
  status: productStatusSchema,
  reason: shortTextSchema.optional(),
});

// ── Media ───────────────────────────────────────────────────────────────────

export const attachProductMediaSchema = z.object({
  /** Must already exist — DocumentsService owns upload, scanning, and storage. */
  documentId: idSchema,
  type: productMediaTypeSchema.default('IMAGE'),
  title: shortTextSchema.optional(),
  isPrimary: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

export type AttachProductMediaDto = z.infer<typeof attachProductMediaSchema>;

// ── Bill of materials ───────────────────────────────────────────────────────

export const addBomComponentSchema = z.object({
  componentProductId: idSchema,
  quantity: quantitySchema,
  isOptional: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  notes: mediumTextSchema.optional(),
});

export type AddBomComponentDto = z.infer<typeof addBomComponentSchema>;

/** How deep the explosion walker will recurse before declaring a cycle. */
export const MAX_BOM_DEPTH = 10;

// ── Queries ─────────────────────────────────────────────────────────────────

export const listProductsQuerySchema = cursorPaginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  type: productTypeSchema.optional(),
  status: z.union([productStatusSchema, z.array(productStatusSchema)]).optional(),
  categoryId: idSchema.optional(),
  brandId: idSchema.optional(),
  /** Includes products in descendant categories, not just the exact match. */
  includeSubcategories: z.coerce.boolean().default(false),
  isSerialized: z.coerce.boolean().optional(),
  hsnCode: z.string().trim().max(8).optional(),
  tag: z.string().trim().max(40).optional(),
  sort: z.string().max(200).optional(),
});

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

/**
 * Specification filtering — "DAQ modules with 24 V DC supply".
 *
 * This is the query that justifies specifications being rows rather than a JSON
 * blob. Industrial buyers genuinely shop this way.
 */
export const specificationFilterSchema = z.object({
  name: shortTextSchema,
  value: shortTextSchema,
});

export const searchProductsBySpecSchema = cursorPaginationSchema.extend({
  specs: z.array(specificationFilterSchema).min(1).max(10),
  categoryId: idSchema.optional(),
});

// ── Responses ───────────────────────────────────────────────────────────────

export const productSummarySchema = z.object({
  id: idSchema,
  sku: z.string(),
  name: z.string(),
  slug: z.string(),
  type: productTypeSchema,
  status: productStatusSchema,
  categoryId: idSchema.nullable(),
  categoryName: z.string().nullable(),
  brandId: idSchema.nullable(),
  brandName: z.string().nullable(),
  uomCode: z.string().nullable(),
  hsnCode: z.string().nullable(),
  sacCode: z.string().nullable(),
  gstRate: z.string(),
  isSerialized: z.boolean(),
  isBatchTracked: z.boolean(),
  warrantyMonths: z.number().int().nullable(),
  leadTimeDays: z.number().int().nullable(),
  minOrderQty: z.string(),
  tags: z.array(z.string()),
  revision: z.number().int(),
  specificationCount: z.number().int().nonnegative(),
  bomComponentCount: z.number().int().nonnegative(),
  createdAt: dateTimeSchema,
});

export type ProductSummary = z.infer<typeof productSummarySchema>;

/** One line of an exploded kit. */
export interface BomExplosionLine {
  productId: string;
  sku: string;
  name: string;
  type: z.infer<typeof productTypeSchema>;
  /** Quantity per ONE unit of the top-level parent, multiplied down the tree. */
  quantityPerParent: string;
  /** Quantity for the requested parent quantity. */
  totalQuantity: string;
  isOptional: boolean;
  depth: number;
  path: string[];
}
