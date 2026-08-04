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
import { gstinSchema } from '../primitives/india';
import {
  invoiceStatusSchema,
  supplyTypeSchema,
  taxNoteReasonSchema,
  taxNoteStatusSchema,
  taxNoteTypeSchema,
} from '../enums';
import { salesLineInputSchema } from '../sales/order.schema';

/**
 * Tax invoice and tax note contracts.
 *
 * ── Two asymmetries carried over from Phase 7, and one new one ─────────────
 *
 * A REQUEST still never carries a price (ADR-0007, ADR-0011). An invoice raised
 * from an order carries no line data at all — the lines come from the order's
 * own snapshot, and letting a client restate them would let it bill something
 * other than what was agreed.
 *
 * The new one: a request never carries an invoice NUMBER either. The statutory
 * series is allocated server-side, inside the issue transaction, and only at
 * issue (`NumberSequenceService`). A client-supplied number would put a gap in
 * a GST series the first time a request failed after allocation.
 */

const stateCodeSchema = z
  .string()
  .regex(/^\d{2}$/, 'A two-digit GST state code')
  .describe('GST state code, e.g. 27 for Maharashtra');

// ── Creating a draft ────────────────────────────────────────────────────────

/**
 * Bills an existing order.
 *
 * `lines` is optional and, when present, carries only order-line ids and
 * quantities — for the partial-billing case where a 10-unit order ships in two
 * lots. Omitting it bills everything not yet billed, which is the common case.
 */
export const createInvoiceFromOrderSchema = z.object({
  invoiceDate: dateOnlySchema.optional(),
  /** Overrides the order's payment terms. The due date is derived from it. */
  paymentTermsCode: shortTextSchema.optional(),
  lines: z
    .array(
      z.object({
        orderLineId: idSchema,
        quantity: quantitySchema,
      }),
    )
    .min(1)
    .max(200)
    .optional(),
  notes: longTextSchema.optional(),
  termsAndConditions: longTextSchema.optional(),
});

export type CreateInvoiceFromOrderDto = z.infer<typeof createInvoiceFromOrderSchema>;

/** Bills exactly what a shipment carried — the honest default for part-shipped orders. */
export const createInvoiceFromShipmentSchema = z.object({
  invoiceDate: dateOnlySchema.optional(),
  paymentTermsCode: shortTextSchema.optional(),
  notes: longTextSchema.optional(),
  termsAndConditions: longTextSchema.optional(),
});

/**
 * A direct invoice, with no originating order.
 *
 * This is the ONLY place in Phase 8 that calls `PricingService.quote()`. An
 * order-derived invoice copies the order's snapshot instead — re-pricing at
 * invoice time would silently bill today's numbers for what was agreed weeks
 * ago, which is the exact failure ADR-0011 exists to prevent.
 */
export const createInvoiceSchema = z
  .object({
    distributorId: idSchema.optional(),
    customerId: idSchema.optional(),
    invoiceDate: dateOnlySchema.optional(),
    paymentTermsCode: shortTextSchema.optional(),
    placeOfSupplyStateCode: stateCodeSchema.optional(),
    priceListId: idSchema.optional(),
    isReverseCharge: z.boolean().default(false),
    customerPoNumber: shortTextSchema.optional(),
    customerPoDate: dateOnlySchema.optional(),
    lines: z.array(salesLineInputSchema).min(1).max(200),
    notes: longTextSchema.optional(),
    termsAndConditions: longTextSchema.optional(),
  })
  .refine((v) => Boolean(v.distributorId) !== Boolean(v.customerId), {
    path: ['distributorId'],
    message:
      'An invoice is addressed to exactly one party — a distributor or a customer, not both',
  });

export type CreateInvoiceDto = z.infer<typeof createInvoiceSchema>;

export const updateInvoiceSchema = z.object({
  invoiceDate: dateOnlySchema.optional(),
  paymentTermsCode: shortTextSchema.optional(),
  placeOfSupplyStateCode: stateCodeSchema.optional(),
  customerPoNumber: shortTextSchema.optional(),
  customerPoDate: dateOnlySchema.optional(),
  isReverseCharge: z.boolean().optional(),
  notes: longTextSchema.optional(),
  termsAndConditions: longTextSchema.optional(),
});

export type UpdateInvoiceDto = z.infer<typeof updateInvoiceSchema>;

/**
 * Issuing takes no body beyond an optional date.
 *
 * Everything else about an issue is a decision the server makes: the number,
 * the supply-type classification, the due date, and the six refusals of
 * docs/23 §5.1. There is nothing here a caller could usefully vary, and a body
 * would only create the impression that they could.
 */
export const issueInvoiceSchema = z.object({
  /** Defaults to today. Cannot precede the order date or be in the future. */
  invoiceDate: dateOnlySchema.optional(),
});

export const cancelInvoiceSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, 'A cancelled tax invoice must carry an explanation — it stays in the return')
    .max(500),
});

export const sendInvoiceSchema = z.object({
  to: z.array(z.string().trim().toLowerCase().email()).max(10).optional(),
  message: longTextSchema.optional(),
});

export const listInvoicesQuerySchema = cursorPaginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  status: z.union([invoiceStatusSchema, z.array(invoiceStatusSchema)]).optional(),
  distributorId: idSchema.optional(),
  customerId: idSchema.optional(),
  orderId: idSchema.optional(),
  supplyType: supplyTypeSchema.optional(),
  /** Past the due date with something still owing. Computed, never a status. */
  overdueOnly: z.coerce.boolean().optional(),
  /** Anything not fully settled — the collections worklist. */
  outstandingOnly: z.coerce.boolean().optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

// ── Tax notes (credit / debit) ──────────────────────────────────────────────

/**
 * A note line.
 *
 * `invoiceLineId` ties the correction to what it corrects, which is what makes
 * a partial return computable. It is optional because a document-level
 * correction — a post-sale discount, say — corrects no particular line.
 *
 * The rate is NOT accepted from the client: it is copied from the invoice line
 * being corrected, or resolved from the tax table for a document-level note. A
 * note taxed at a different rate from the invoice it corrects is a mismatch the
 * portal will reject.
 */
export const taxNoteLineInputSchema = z.object({
  invoiceLineId: idSchema.optional(),
  description: mediumTextSchema,
  quantity: quantitySchema.optional(),
  /** The value being corrected, GST-exclusive. Tax is derived forward. */
  taxableValue: positiveMoneySchema,
});

export const createTaxNoteSchema = z.object({
  originalInvoiceId: idSchema,
  reason: taxNoteReasonSchema,
  reasonNote: mediumTextSchema.optional(),
  noteDate: dateOnlySchema.optional(),
  lines: z.array(taxNoteLineInputSchema).min(1).max(200),
});

export type CreateTaxNoteDto = z.infer<typeof createTaxNoteSchema>;

export const issueTaxNoteSchema = z.object({
  noteDate: dateOnlySchema.optional(),
});

export const listTaxNotesQuerySchema = cursorPaginationSchema.extend({
  status: taxNoteStatusSchema.optional(),
  originalInvoiceId: idSchema.optional(),
  distributorId: idSchema.optional(),
  customerId: idSchema.optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

export type ListTaxNotesQuery = z.infer<typeof listTaxNotesQuerySchema>;

// ── Response shapes ─────────────────────────────────────────────────────────

export const invoiceLineSummarySchema = z.object({
  id: idSchema,
  lineNumber: z.number().int(),
  productId: idSchema,
  variantId: idSchema.nullable(),
  orderLineId: idSchema.nullable(),
  sku: z.string(),
  description: z.string(),
  quantity: z.string(),
  uomCode: z.string().nullable(),
  unitListPrice: z.string(),
  unitPrice: z.string(),
  discountAmount: z.string(),
  discountPercent: z.string(),
  taxableValue: z.string(),
  hsnSacCode: z.string().nullable(),
  gstRate: z.string(),
  cgst: z.string(),
  sgst: z.string(),
  igst: z.string(),
  cess: z.string(),
  totalTax: z.string(),
  lineTotal: z.string(),
  /**
   * Null means no `TaxRate` row covered this HSN/SAC on the invoice date, so
   * the rate fell back to the product snapshot. Fine for a quote, refused at
   * issue (docs/23 §5.1 refusal 3).
   */
  taxRateId: idSchema.nullable(),
});

export type InvoiceLineSummary = z.infer<typeof invoiceLineSummarySchema>;

export const invoiceSummarySchema = z.object({
  id: idSchema,
  /** Null while DRAFT — no statutory number is consumed until issue. */
  number: z.string().nullable(),
  status: invoiceStatusSchema,
  supplyType: supplyTypeSchema,
  isReverseCharge: z.boolean(),

  distributorId: idSchema.nullable(),
  distributorName: z.string().nullable(),
  customerId: idSchema.nullable(),
  customerName: z.string().nullable(),
  orderId: idSchema.nullable(),
  orderNumber: z.string().nullable(),

  counterpartyName: z.string(),
  counterpartyGstin: z.string().nullable(),
  supplierStateCode: z.string(),
  placeOfSupplyStateCode: z.string(),
  /** Derived from the two state codes — which half of ADR-0008 applied. */
  isInterState: z.boolean(),

  invoiceDate: z.string(),
  dueDate: z.string().nullable(),
  paymentTermsCode: z.string().nullable(),

  subtotal: z.string(),
  totalDiscount: z.string(),
  taxableValue: z.string(),
  totalCgst: z.string(),
  totalSgst: z.string(),
  totalIgst: z.string(),
  totalCess: z.string(),
  totalTax: z.string(),
  roundOff: z.string(),
  grandTotal: z.string(),

  amountPaid: z.string(),
  amountCredited: z.string(),
  amountOutstanding: z.string(),

  /** Computed at read time, never stored — see docs/23 §5. */
  isOverdue: z.boolean(),
  daysPastDue: z.number().int(),

  lineCount: z.number().int().nonnegative(),
  issuedAt: dateTimeSchema.nullable(),
  sentAt: dateTimeSchema.nullable(),
  cancelledAt: dateTimeSchema.nullable(),
  cancelledReason: z.string().nullable(),
  createdAt: dateTimeSchema,
});

export type InvoiceSummary = z.infer<typeof invoiceSummarySchema>;

export const taxNoteSummarySchema = z.object({
  id: idSchema,
  type: taxNoteTypeSchema,
  number: z.string().nullable(),
  status: taxNoteStatusSchema,
  originalInvoiceId: idSchema,
  originalInvoiceNumber: z.string().nullable(),
  reason: taxNoteReasonSchema,
  reasonNote: z.string().nullable(),
  counterpartyName: z.string(),
  counterpartyGstin: z.string().nullable(),
  placeOfSupplyStateCode: z.string(),
  noteDate: z.string(),
  taxableValue: z.string(),
  totalCgst: z.string(),
  totalSgst: z.string(),
  totalIgst: z.string(),
  totalCess: z.string(),
  totalTax: z.string(),
  roundOff: z.string(),
  grandTotal: z.string(),
  lineCount: z.number().int().nonnegative(),
  issuedAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
});

export type TaxNoteSummary = z.infer<typeof taxNoteSummarySchema>;

/**
 * Why an issue was refused, as a machine-readable code.
 *
 * A code rather than only a message because the frontend needs to act on the
 * difference: `STATUTORY_IDENTITY_UNVERIFIED` is fixed in Settings by an admin,
 * while `TAX_RATE_NOT_AUTHORITATIVE` is fixed in the tax table by finance. The
 * same 422 with different prose would leave the UI guessing.
 */
export const INVOICE_ISSUE_REFUSALS = [
  'STATUTORY_IDENTITY_UNVERIFIED',
  'SECONDARY_ORDER_NOT_INVOICEABLE',
  'TAX_RATE_NOT_AUTHORITATIVE',
  'COUNTERPARTY_GSTIN_INVALID',
  'EMPTY_INVOICE',
  /** A tax invoice documents a supply that has already been made. */
  'FUTURE_DATED',
] as const;
export type InvoiceIssueRefusal = (typeof INVOICE_ISSUE_REFUSALS)[number];

/** The counterparty identity an invoice snapshots, validated before it is stored. */
export const counterpartyIdentitySchema = z.object({
  name: shortTextSchema,
  gstin: gstinSchema.optional(),
});
