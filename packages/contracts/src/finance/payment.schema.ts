import { z } from 'zod';
import {
  dateOnlySchema,
  dateTimeSchema,
  idSchema,
  longTextSchema,
  mediumTextSchema,
  shortTextSchema,
} from '../primitives/common';
import { Money, moneySchema, nonZeroMoneySchema, positiveMoneySchema } from '../primitives/money';
import { cursorPaginationSchema } from '../primitives/pagination';
import { ifscSchema } from '../primitives/india';
import { paymentMethodSchema, paymentStatusSchema } from '../enums';

/**
 * Payment contracts. See ADR-0018.
 *
 * The shape encodes the decision that recording and verifying are different
 * acts: `createPaymentSchema` has no `status` field and no `verifiedById`, so
 * there is no request that can record and verify in one step. The API surface
 * makes the segregation structural rather than something the service has to
 * remember to check.
 */

// ── Recording ───────────────────────────────────────────────────────────────

export const createPaymentSchema = z
  .object({
    distributorId: idSchema.optional(),
    customerId: idSchema.optional(),

    method: paymentMethodSchema,
    /** Cash actually received, excluding any TDS the payer withheld. */
    amount: nonZeroMoneySchema,
    /**
     * Tax deducted at source. Held separately from `amount` because the two
     * reconcile against different statements — the bank, and Form 26AS
     * (ADR-0018 §4).
     */
    tdsAmount: positiveMoneySchema.optional(),

    paymentDate: dateOnlySchema.optional(),

    referenceNumber: shortTextSchema.optional(),
    bankName: shortTextSchema.optional(),
    ifsc: ifscSchema.optional(),
    chequeNumber: shortTextSchema.optional(),
    chequeDate: dateOnlySchema.optional(),

    notes: longTextSchema.optional(),

    /**
     * Settle these invoices as soon as the payment is verified.
     *
     * A convenience, not a shortcut past the control: nothing is allocated
     * while the payment is `RECORDED`. Supplying it here only saves a second
     * request after verification.
     */
    allocations: z
      .array(
        z.object({
          invoiceId: idSchema,
          amount: nonZeroMoneySchema,
        }),
      )
      .max(100)
      .optional(),
  })
  .refine((v) => Boolean(v.distributorId) !== Boolean(v.customerId), {
    path: ['distributorId'],
    message: 'A payment comes from exactly one party — a distributor or a customer',
  })
  .superRefine((value, ctx) => {
    // A cheque with no number cannot be traced to a bank statement, which is
    // the whole basis on which it will later be verified.
    if ((value.method === 'CHEQUE' || value.method === 'DEMAND_DRAFT') && !value.chequeNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chequeNumber'],
        message: `A ${value.method === 'CHEQUE' ? 'cheque' : 'demand draft'} needs its number — it is what verification matches against`,
      });
    }

    if (value.allocations?.length) {
      const allocated = Money.sum(value.allocations.map((a) => a.amount));
      const available = Money.of(value.amount).add(value.tdsAmount ?? '0');
      if (allocated.gt(available)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allocations'],
          message:
            `Allocations total ${allocated.format()} but the payment is worth ` +
            `${available.format()} including TDS`,
        });
      }

      const invoiceIds = value.allocations.map((a) => a.invoiceId);
      if (new Set(invoiceIds).size !== invoiceIds.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allocations'],
          message: 'One invoice cannot appear twice — combine the amounts instead',
        });
      }
    }
  });

export type CreatePaymentDto = z.infer<typeof createPaymentSchema>;

/** Editable only while RECORDED. After verification the ledger is already posted. */
export const updatePaymentSchema = z.object({
  method: paymentMethodSchema.optional(),
  amount: nonZeroMoneySchema.optional(),
  tdsAmount: positiveMoneySchema.optional(),
  paymentDate: dateOnlySchema.optional(),
  referenceNumber: shortTextSchema.optional(),
  bankName: shortTextSchema.optional(),
  chequeNumber: shortTextSchema.optional(),
  chequeDate: dateOnlySchema.optional(),
  notes: longTextSchema.optional(),
});

export type UpdatePaymentDto = z.infer<typeof updatePaymentSchema>;

// ── Verifying ───────────────────────────────────────────────────────────────

/**
 * Confirming a receipt against the bank.
 *
 * The verifier is taken from the authenticated caller, never from the body —
 * accepting it would let one person record a payment and name someone else as
 * the verifier, which is the control read backwards.
 */
export const verifyPaymentSchema = z.object({
  /** What the receipt was matched against — a statement line, a UTR, a slip. */
  verificationNote: mediumTextSchema.optional(),
  /** Allocate on verification, in the same transaction. */
  allocations: z
    .array(
      z.object({
        invoiceId: idSchema,
        amount: nonZeroMoneySchema,
      }),
    )
    .max(100)
    .optional(),
});

export type VerifyPaymentDto = z.infer<typeof verifyPaymentSchema>;

export const bouncePaymentSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'Say why it bounced — the partner’s ledger will show this')
    .max(500),
});

// ── Allocating ──────────────────────────────────────────────────────────────

export const allocatePaymentSchema = z.object({
  allocations: z
    .array(
      z.object({
        invoiceId: idSchema,
        amount: nonZeroMoneySchema,
        notes: mediumTextSchema.optional(),
      }),
    )
    .min(1)
    .max(100),
});

export type AllocatePaymentDto = z.infer<typeof allocatePaymentSchema>;

export const listPaymentsQuerySchema = cursorPaginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  status: z.union([paymentStatusSchema, z.array(paymentStatusSchema)]).optional(),
  method: paymentMethodSchema.optional(),
  distributorId: idSchema.optional(),
  customerId: idSchema.optional(),
  /** Verified receipts with money still to apply — the allocation worklist. */
  unallocatedOnly: z.coerce.boolean().optional(),
  /** Recorded but not yet confirmed — the verification worklist. */
  awaitingVerification: z.coerce.boolean().optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

// ── Response shapes ─────────────────────────────────────────────────────────

export const paymentAllocationSummarySchema = z.object({
  id: idSchema,
  invoiceId: idSchema,
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string(),
  invoiceGrandTotal: z.string(),
  invoiceOutstanding: z.string(),
  amount: z.string(),
  tdsPortion: z.string(),
  notes: z.string().nullable(),
  createdAt: dateTimeSchema,
});

export type PaymentAllocationSummary = z.infer<typeof paymentAllocationSummarySchema>;

export const paymentSummarySchema = z.object({
  id: idSchema,
  number: z.string(),
  status: paymentStatusSchema,
  method: paymentMethodSchema,

  distributorId: idSchema.nullable(),
  distributorName: z.string().nullable(),
  customerId: idSchema.nullable(),
  customerName: z.string().nullable(),

  amount: z.string(),
  tdsAmount: z.string(),
  /** amount + tdsAmount — what can be applied to invoices. */
  totalValue: z.string(),
  unallocatedAmount: z.string(),

  paymentDate: z.string(),
  referenceNumber: z.string().nullable(),
  bankName: z.string().nullable(),
  chequeNumber: z.string().nullable(),
  chequeDate: z.string().nullable(),

  recordedById: idSchema,
  recordedByName: z.string().nullable(),
  verifiedById: idSchema.nullable(),
  verifiedByName: z.string().nullable(),
  verifiedAt: dateTimeSchema.nullable(),

  /** True while this receipt has no financial effect at all (ADR-0018 §1). */
  awaitingVerification: z.boolean(),

  bouncedAt: dateTimeSchema.nullable(),
  bouncedReason: z.string().nullable(),

  allocationCount: z.number().int().nonnegative(),
  notes: z.string().nullable(),
  createdAt: dateTimeSchema,
});

export type PaymentSummary = z.infer<typeof paymentSummarySchema>;

/**
 * What a payment settled, from the invoice's side.
 *
 * Present on the invoice detail so "how was this paid" needs no second request
 * — the question is asked every time a partner disputes a balance.
 */
export const invoiceSettlementSchema = z.object({
  paymentId: idSchema,
  paymentNumber: z.string(),
  paymentDate: z.string(),
  method: paymentMethodSchema,
  amount: z.string(),
  tdsPortion: z.string(),
  referenceNumber: z.string().nullable(),
});

/** A write-off is a ledger act, not a payment — it needs its own reason trail. */
export const writeOffSchema = z.object({
  partyType: z.enum(['DISTRIBUTOR', 'CUSTOMER']),
  partyId: idSchema,
  amount: nonZeroMoneySchema,
  reason: z
    .string()
    .trim()
    .min(10, 'A write-off must be explained — it is money the company will not collect')
    .max(500),
  entryDate: dateOnlySchema.optional(),
});

export type WriteOffDto = z.infer<typeof writeOffSchema>;

/**
 * A manual ledger adjustment, and the opening balance import.
 *
 * `amount` is signed here, unusually for this codebase: an adjustment is the
 * one entry type whose direction is genuinely the caller's decision rather than
 * implied by the document. Positive debits (they owe more), negative credits.
 */
export const ledgerAdjustmentSchema = z.object({
  partyType: z.enum(['DISTRIBUTOR', 'CUSTOMER']),
  partyId: idSchema,
  amount: moneySchema.refine((v) => !Money.of(v).isZero(), {
    message: 'A zero adjustment is a non-event recorded as if it were one',
  }),
  narration: mediumTextSchema,
  entryDate: dateOnlySchema.optional(),
  /** Set for an opening balance carried in from a previous system. */
  isOpeningBalance: z.boolean().default(false),
});

export type LedgerAdjustmentDto = z.infer<typeof ledgerAdjustmentSchema>;
