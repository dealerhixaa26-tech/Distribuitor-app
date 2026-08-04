import { z } from 'zod';
import {
  dateOnlySchema,
  dateTimeSchema,
  idSchema,
  longTextSchema,
  mediumTextSchema,
  shortTextSchema,
} from '../primitives/common';
import { positiveMoneySchema, quantitySchema } from '../primitives/money';
import { cursorPaginationSchema } from '../primitives/pagination';
import {
  approvalKindSchema,
  orderStatusSchema,
  orderTypeSchema,
  quotationStatusSchema,
  shipmentStatusSchema,
} from '../enums';
import { priceOverrideSchema } from '../catalog/pricing.schema';

/**
 * Quotation, order, approval, and shipment contracts.
 *
 * ── The shape everything below shares ──────────────────────────────────────
 * A REQUEST carries only what a human chose: product, quantity, and optionally
 * an override. It never carries a price. Prices are resolved server-side by
 * `PricingService.quote()` (ADR-0007) and then SNAPSHOTTED onto the line
 * (ADR-0011).
 *
 * That asymmetry is deliberate and load-bearing: if a client could post a
 * price, the pricing engine would be advisory rather than authoritative, and
 * the discount ceilings it enforces would be trivially bypassed.
 */

// ── Lines ───────────────────────────────────────────────────────────────────

export const salesLineInputSchema = z.object({
  productId: idSchema,
  variantId: idSchema.optional(),
  quantity: quantitySchema,
  /** Per-deal price override. Mandatory reason, flagged for approval. */
  override: priceOverrideSchema.optional(),
  notes: mediumTextSchema.optional(),
});

export type SalesLineInput = z.infer<typeof salesLineInputSchema>;

// ── Quotations ──────────────────────────────────────────────────────────────

export const createQuotationSchema = z
  .object({
    distributorId: idSchema.optional(),
    customerId: idSchema.optional(),
    quotationDate: dateOnlySchema.optional(),
    validUntil: dateOnlySchema.optional(),
    placeOfSupplyStateCode: z.string().regex(/^\d{2}$/, 'A two-digit GST state code').optional(),
    priceListId: idSchema.optional(),
    lines: z.array(salesLineInputSchema).min(1).max(200),
    termsAndConditions: longTextSchema.optional(),
    notes: longTextSchema.optional(),
  })
  .refine((v) => v.distributorId || v.customerId, {
    path: ['distributorId'],
    message: 'A quotation must be addressed to a distributor or a customer',
  });

export type CreateQuotationDto = z.infer<typeof createQuotationSchema>;

export const updateQuotationSchema = z.object({
  validUntil: dateOnlySchema.nullable().optional(),
  placeOfSupplyStateCode: z.string().regex(/^\d{2}$/).optional(),
  lines: z.array(salesLineInputSchema).min(1).max(200).optional(),
  termsAndConditions: longTextSchema.optional(),
  notes: longTextSchema.optional(),
});

export type UpdateQuotationDto = z.infer<typeof updateQuotationSchema>;

export const sendQuotationSchema = z.object({
  /** Defaults to the distributor's or customer's primary contact. */
  to: z.array(z.string().trim().toLowerCase().email()).max(10).optional(),
  message: longTextSchema.optional(),
});

export const rejectQuotationSchema = z.object({
  reason: z.string().trim().min(5, 'Say why it was rejected').max(500),
});

export const listQuotationsQuerySchema = cursorPaginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  status: quotationStatusSchema.optional(),
  distributorId: idSchema.optional(),
  customerId: idSchema.optional(),
  /** Live quotations whose validity lapses within N days — the follow-up list. */
  expiringInDays: z.coerce.number().int().min(1).max(365).optional(),
});

export type ListQuotationsQuery = z.infer<typeof listQuotationsQuerySchema>;

// ── Orders ──────────────────────────────────────────────────────────────────

export const createOrderSchema = z
  .object({
    type: orderTypeSchema.default('PRIMARY'),
    distributorId: idSchema.optional(),
    customerId: idSchema.optional(),
    quotationId: idSchema.optional(),
    /** Which warehouse fulfils this. Defaults to the default warehouse. */
    warehouseId: idSchema.optional(),

    orderDate: dateOnlySchema.optional(),
    expectedDate: dateOnlySchema.optional(),
    customerPoNumber: shortTextSchema.optional(),
    customerPoDate: dateOnlySchema.optional(),
    paymentTermsCode: shortTextSchema.optional(),

    placeOfSupplyStateCode: z.string().regex(/^\d{2}$/).optional(),
    priceListId: idSchema.optional(),

    lines: z.array(salesLineInputSchema).min(1).max(200),
    notes: longTextSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // Mirrors the CHECK constraint in migration 0008. A PRIMARY order is
    // Hixaa → distributor; a SECONDARY order is distributor → customer.
    // Mixing them up would put sell-out revenue in the sell-in ledger.
    if (value.type === 'PRIMARY' && !value.distributorId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['distributorId'],
        message: 'A PRIMARY order (sell-in) must name the distributor buying from Hixaa',
      });
    }
    if (value.type === 'SECONDARY' && !value.customerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customerId'],
        message: 'A SECONDARY order (sell-out) must name the end customer',
      });
    }
  });

export type CreateOrderDto = z.infer<typeof createOrderSchema>;

export const updateOrderSchema = z.object({
  expectedDate: dateOnlySchema.nullable().optional(),
  customerPoNumber: shortTextSchema.optional(),
  customerPoDate: dateOnlySchema.optional(),
  paymentTermsCode: shortTextSchema.optional(),
  warehouseId: idSchema.optional(),
  lines: z.array(salesLineInputSchema).min(1).max(200).optional(),
  notes: longTextSchema.optional(),
});

export type UpdateOrderDto = z.infer<typeof updateOrderSchema>;

/**
 * Approving an order.
 *
 * `creditOverrideReason` is what turns a refused credit check into an accepted
 * one, and only a Finance Manager or above may supply it (docs/00 §4.2
 * invariant 1). Its presence alone does not authorise anything — the service
 * checks the caller's role — but its ABSENCE means a breach is refused outright.
 */
export const approveOrderSchema = z.object({
  creditOverrideReason: z
    .string()
    .trim()
    .min(10, 'A credit override must be explained')
    .max(500)
    .optional(),
  /** Why a discount above the submitter's ceiling was granted. */
  approvalReason: mediumTextSchema.optional(),
});

export type ApproveOrderDto = z.infer<typeof approveOrderSchema>;

export const rejectOrderSchema = z.object({
  reason: z.string().trim().min(5, 'Say why it was rejected').max(500),
});

export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(5, 'Say why it was cancelled').max(500),
});

export const listOrdersQuerySchema = cursorPaginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  type: orderTypeSchema.optional(),
  status: z.union([orderStatusSchema, z.array(orderStatusSchema)]).optional(),
  distributorId: idSchema.optional(),
  customerId: idSchema.optional(),
  /** Orders with anything still owed — the backorder report. */
  hasBackorder: z.coerce.boolean().optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

// ── Shipments ───────────────────────────────────────────────────────────────

export const createShipmentSchema = z.object({
  orderId: idSchema,
  warehouseId: idSchema.optional(),
  lines: z
    .array(
      z.object({
        orderLineId: idSchema,
        quantity: quantitySchema,
        /**
         * One per unit for a serialized product (ADR-0009). Validated against
         * the quantity before any stock moves, so a short list fails the whole
         * dispatch rather than shipping untraceable units.
         */
        serials: z.array(shortTextSchema).max(1000).optional(),
      }),
    )
    .min(1)
    .max(200),
  notes: longTextSchema.optional(),
});

export type CreateShipmentDto = z.infer<typeof createShipmentSchema>;

export const dispatchShipmentSchema = z.object({
  carrierName: shortTextSchema.optional(),
  /** Lorry Receipt — the consignment note the transporter issues. */
  lrNumber: shortTextSchema.optional(),
  vehicleNumber: shortTextSchema.optional(),
  driverName: shortTextSchema.optional(),
  driverPhone: shortTextSchema.optional(),
  freightAmount: positiveMoneySchema.optional(),
});

export type DispatchShipmentDto = z.infer<typeof dispatchShipmentSchema>;

export const deliverShipmentSchema = z.object({
  podDocumentId: idSchema.optional(),
  podReceivedBy: shortTextSchema.optional(),
  deliveredAt: dateTimeSchema.optional(),
});

export const listShipmentsQuerySchema = cursorPaginationSchema.extend({
  orderId: idSchema.optional(),
  status: shipmentStatusSchema.optional(),
  warehouseId: idSchema.optional(),
});

// ── Response shapes ─────────────────────────────────────────────────────────

/** The commercial figures snapshotted onto a line. See ADR-0011. */
export const salesLineSummarySchema = z.object({
  id: idSchema,
  lineNumber: z.number().int(),
  productId: idSchema,
  variantId: idSchema.nullable(),
  sku: z.string(),
  description: z.string(),
  quantity: z.string(),
  uomCode: z.string().nullable(),
  unitListPrice: z.string(),
  unitPrice: z.string(),
  discountAmount: z.string(),
  discountPercent: z.string(),
  overrideReason: z.string().nullable(),
  taxableValue: z.string(),
  hsnSacCode: z.string().nullable(),
  gstRate: z.string(),
  cgst: z.string(),
  sgst: z.string(),
  igst: z.string(),
  totalTax: z.string(),
  lineTotal: z.string(),
});

export const orderLineSummarySchema = salesLineSummarySchema.extend({
  quantityReserved: z.string(),
  quantityBackordered: z.string(),
  quantityDispatched: z.string(),
  /** quantity − dispatched: what is still owed to the customer. */
  quantityOutstanding: z.string(),
  expectedAvailableDate: z.string().nullable(),
  /** True when this line cannot ship yet because stock was never reserved. */
  isBackordered: z.boolean(),
});

export type OrderLineSummary = z.infer<typeof orderLineSummarySchema>;

const documentTotalsSchema = z.object({
  subtotal: z.string(),
  totalDiscount: z.string(),
  taxableValue: z.string(),
  totalCgst: z.string(),
  totalSgst: z.string(),
  totalIgst: z.string(),
  totalTax: z.string(),
  roundOff: z.string(),
  grandTotal: z.string(),
});

export const quotationSummarySchema = documentTotalsSchema.extend({
  id: idSchema,
  number: z.string(),
  status: quotationStatusSchema,
  groupId: idSchema,
  revision: z.number().int(),
  distributorId: idSchema.nullable(),
  distributorName: z.string().nullable(),
  customerId: idSchema.nullable(),
  customerName: z.string().nullable(),
  quotationDate: z.string(),
  validUntil: z.string().nullable(),
  /** True when validUntil has passed — computed, not stored, so it cannot go stale. */
  isExpired: z.boolean(),
  lineCount: z.number().int().nonnegative(),
  sentAt: dateTimeSchema.nullable(),
  acceptedAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
});

export type QuotationSummary = z.infer<typeof quotationSummarySchema>;

export const orderSummarySchema = documentTotalsSchema.extend({
  id: idSchema,
  number: z.string(),
  type: orderTypeSchema,
  status: orderStatusSchema,
  distributorId: idSchema.nullable(),
  distributorName: z.string().nullable(),
  customerId: idSchema.nullable(),
  customerName: z.string().nullable(),
  quotationId: idSchema.nullable(),
  warehouseId: idSchema.nullable(),
  orderDate: z.string(),
  expectedDate: z.string().nullable(),
  customerPoNumber: z.string().nullable(),
  creditOverridden: z.boolean(),
  creditOverrideReason: z.string().nullable(),
  lineCount: z.number().int().nonnegative(),
  /** Aggregates across lines, so the list can show fulfilment at a glance. */
  hasBackorder: z.boolean(),
  fullyDispatched: z.boolean(),
  approvedAt: dateTimeSchema.nullable(),
  approvedById: idSchema.nullable(),
  createdAt: dateTimeSchema,
});

export type OrderSummary = z.infer<typeof orderSummarySchema>;

export const orderApprovalSummarySchema = z.object({
  id: idSchema,
  kind: approvalKindSchema,
  requestedValue: z.string(),
  approverCeiling: z.string().nullable(),
  approvedById: idSchema,
  approverName: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: dateTimeSchema,
});

export const shipmentSummarySchema = z.object({
  id: idSchema,
  number: z.string(),
  orderId: idSchema,
  orderNumber: z.string(),
  status: shipmentStatusSchema,
  warehouseId: idSchema,
  warehouseCode: z.string(),
  carrierName: z.string().nullable(),
  lrNumber: z.string().nullable(),
  vehicleNumber: z.string().nullable(),
  lineCount: z.number().int().nonnegative(),
  totalQuantity: z.string(),
  dispatchedAt: dateTimeSchema.nullable(),
  deliveredAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
});

export type ShipmentSummary = z.infer<typeof shipmentSummarySchema>;

/** One entry in the order's business narrative. */
export interface OrderTimelineEntry {
  id: string;
  event: string;
  description: string;
  metadata: Record<string, unknown> | null;
  actorId: string | null;
  actorName: string | null;
  createdAt: string;
}

/**
 * What a credit check found. Returned on refusal AND on a successful override,
 * so the figures behind the decision are always visible rather than only
 * appearing in an error message.
 */
export interface CreditCheckResult {
  distributorCode: string;
  creditLimit: string;
  /** Approved-but-unbilled orders, plus outstanding invoices once Phase 8 lands. */
  currentExposure: string;
  orderValue: string;
  /** creditLimit − currentExposure − orderValue. Negative means a breach. */
  headroom: string;
  wouldExceed: boolean;
}
