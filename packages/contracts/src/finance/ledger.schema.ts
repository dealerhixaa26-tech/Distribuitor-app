import { z } from 'zod';
import { dateOnlySchema, dateTimeSchema, idSchema } from '../primitives/common';
import { cursorPaginationSchema } from '../primitives/pagination';
import {
  agingBucketFor,
  ledgerEntryTypeSchema,
  ledgerPartyTypeSchema,
  type AgingBucket,
} from '../enums';

/**
 * Party ledger, outstanding, and aging contracts. See ADR-0015.
 *
 * Everything here is a READ. The ledger is written only as a side effect of a
 * document — issuing an invoice, verifying a payment, issuing a note — plus the
 * two explicit acts (`writeOffSchema`, `ledgerAdjustmentSchema` in
 * `payment.schema.ts`) that have no document of their own.
 *
 * There is deliberately no `createLedgerEntrySchema`. A ledger you can post to
 * directly is a ledger that can disagree with the documents it is supposed to
 * summarise.
 */

export const listPartyLedgerQuerySchema = cursorPaginationSchema.extend({
  entryType: ledgerEntryTypeSchema.optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

export type ListPartyLedgerQuery = z.infer<typeof listPartyLedgerQuerySchema>;

export const partyLedgerEntrySummarySchema = z.object({
  id: idSchema,
  entryType: ledgerEntryTypeSchema,
  entryDate: z.string(),
  narration: z.string(),
  debit: z.string(),
  credit: z.string(),
  /**
   * Balance after this entry, accumulated in document order.
   *
   * Computed by the service over the whole ledger rather than paged, because a
   * running balance that restarts at each page is worse than none — it looks
   * authoritative and is wrong.
   */
  runningBalance: z.string(),
  refType: z.string().nullable(),
  refId: idSchema.nullable(),
  refNumber: z.string().nullable(),
  /** Set when this entry reverses another — a bounced cheque, a correction. */
  reversesId: idSchema.nullable(),
  createdAt: dateTimeSchema,
});

export type PartyLedgerEntrySummary = z.infer<typeof partyLedgerEntrySummarySchema>;

/** A statement of account: the header a partner argues with, plus the rows. */
export const ledgerStatementSchema = z.object({
  partyType: ledgerPartyTypeSchema,
  partyId: idSchema,
  partyName: z.string(),
  partyCode: z.string().nullable(),
  partyGstin: z.string().nullable(),

  /** Balance carried into `from`, so a period statement still reconciles. */
  openingBalance: z.string(),
  totalDebits: z.string(),
  totalCredits: z.string(),
  /** openingBalance + debits − credits. Positive means the party owes Hixaa. */
  closingBalance: z.string(),

  creditLimit: z.string().nullable(),
  /** creditLimit − closingBalance − committed orders. Null when unlimited. */
  availableCredit: z.string().nullable(),

  from: z.string().nullable(),
  to: z.string().nullable(),
  entryCount: z.number().int().nonnegative(),
});

export type LedgerStatement = z.infer<typeof ledgerStatementSchema>;

// ── Outstanding & aging ─────────────────────────────────────────────────────

export const listOutstandingQuerySchema = z.object({
  partyType: ledgerPartyTypeSchema.optional(),
  distributorId: idSchema.optional(),
  customerId: idSchema.optional(),
  /** Only parties with something past due. */
  overdueOnly: z.coerce.boolean().optional(),
  /** The date the aging is measured from. Defaults to today. */
  asOf: dateOnlySchema.optional(),
});

export type ListOutstandingQuery = z.infer<typeof listOutstandingQuerySchema>;

export const agingBucketsSchema = z.object({
  /** Not yet due. Separated from the overdue buckets because it is not a debt problem. */
  current: z.string(),
  d0_30: z.string(),
  d31_60: z.string(),
  d61_90: z.string(),
  d90Plus: z.string(),
  total: z.string(),
});

export type AgingBuckets = z.infer<typeof agingBucketsSchema>;

export const outstandingPartySchema = agingBucketsSchema.extend({
  partyType: ledgerPartyTypeSchema,
  partyId: idSchema,
  partyName: z.string(),
  partyCode: z.string().nullable(),
  invoiceCount: z.number().int().nonnegative(),
  overdueInvoiceCount: z.number().int().nonnegative(),
  /** Days past due of the oldest unsettled invoice — the number that gets chased. */
  oldestDaysPastDue: z.number().int(),
  creditLimit: z.string().nullable(),
  creditUtilisationPercent: z.string().nullable(),
});

export type OutstandingParty = z.infer<typeof outstandingPartySchema>;

export const outstandingReportSchema = z.object({
  asOf: z.string(),
  parties: z.array(outstandingPartySchema),
  totals: agingBucketsSchema,
});

export type OutstandingReport = z.infer<typeof outstandingReportSchema>;

/**
 * Whole days past due.
 *
 * Both dates are compared as `YYYY-MM-DD` strings at UTC midnight rather than
 * as instants. An invoice due "on the 30th" is due on the 30th in Nagpur, and
 * subtracting two timestamps would make it overdue at 18:30 IST on the 29th —
 * which is what a naive `Date.now() - dueDate` produces and what HANDOFF §4.8
 * exists to prevent elsewhere.
 */
export const daysPastDue = (dueDate: string | null, asOf?: Date): number => {
  if (!dueDate) return 0;
  // Injectable `asOf` is the testability mechanism here — see the note on
  // `isOverdue` in enums.ts. Every aging test passes one.
  // eslint-disable-next-line no-restricted-syntax
  const today = (asOf ?? new Date()).toISOString().slice(0, 10);
  const dueMs = Date.parse(`${dueDate}T00:00:00.000Z`);
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  if (Number.isNaN(dueMs) || Number.isNaN(todayMs)) return 0;
  return Math.floor((todayMs - dueMs) / 86_400_000);
};

/** Which aging bucket an invoice belongs in, as of a date. */
export const bucketForInvoice = (dueDate: string | null, asOf?: Date): AgingBucket =>
  agingBucketFor(daysPastDue(dueDate, asOf));
