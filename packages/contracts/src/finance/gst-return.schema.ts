import { z } from 'zod';
import { dateOnlySchema } from '../primitives/common';

/**
 * GSTR-1 and GSTR-3B export contracts.
 *
 * The response shapes mirror the GST portal's own JSON vocabulary — `ctin`,
 * `inum`, `txval`, `camt` — rather than this codebase's camelCase. That is
 * deliberate: the output is destined for the portal or for a CA's offline
 * utility, and a helpfully-renamed field is a field someone has to rename back.
 * The mapping is done once here rather than in whatever consumes it.
 *
 * ── One exclusion runs through everything below ────────────────────────────
 * SECONDARY orders never appear. A sell-out is the distributor's supply to
 * their own customer; Hixaa's GST liability ended at the sell-in invoice
 * (ADR-0014 §6). Enforced twice — at the query here, and at issue — so neither
 * one alone is load-bearing.
 */

export const gstReturnQuerySchema = z
  .object({
    from: dateOnlySchema,
    to: dateOnlySchema,
  })
  .refine((v) => v.from <= v.to, {
    path: ['from'],
    message: '`from` must not be after `to`',
  });

export type GstReturnQuery = z.infer<typeof gstReturnQuerySchema>;

/** The rate-wise tax detail every GSTR-1 line carries. */
export const gstItemDetailSchema = z.object({
  num: z.number().int(),
  itm_det: z.object({
    rt: z.number(),
    txval: z.number(),
    iamt: z.number().optional(),
    camt: z.number().optional(),
    samt: z.number().optional(),
    csamt: z.number().optional(),
  }),
});

/** Table 4 — supplies to registered persons, grouped by counterparty GSTIN. */
export const gstr1B2bSchema = z.object({
  ctin: z.string(),
  inv: z.array(
    z.object({
      inum: z.string(),
      idt: z.string(),
      val: z.number(),
      pos: z.string(),
      rchrg: z.enum(['Y', 'N']),
      inv_typ: z.string(),
      itms: z.array(gstItemDetailSchema),
    }),
  ),
});

/** Table 5 — large inter-state supplies to unregistered persons, invoice-wise. */
export const gstr1B2clSchema = z.object({
  pos: z.string(),
  inv: z.array(
    z.object({
      inum: z.string(),
      idt: z.string(),
      val: z.number(),
      itms: z.array(gstItemDetailSchema),
    }),
  ),
});

/** Table 7 — everything else to unregistered persons, consolidated rate-wise. */
export const gstr1B2csSchema = z.object({
  sply_ty: z.enum(['INTER', 'INTRA']),
  pos: z.string(),
  typ: z.literal('OE'),
  rt: z.number(),
  txval: z.number(),
  iamt: z.number().optional(),
  camt: z.number().optional(),
  samt: z.number().optional(),
  csamt: z.number().optional(),
});

/** Table 9B — credit and debit notes against registered counterparties. */
export const gstr1CdnrSchema = z.object({
  ctin: z.string(),
  nt: z.array(
    z.object({
      ntty: z.enum(['C', 'D']),
      nt_num: z.string(),
      nt_dt: z.string(),
      /** The invoice the note corrects — what makes it a correction. */
      inum: z.string(),
      idt: z.string(),
      pos: z.string(),
      rchrg: z.enum(['Y', 'N']),
      val: z.number(),
      itms: z.array(gstItemDetailSchema),
    }),
  ),
});

/** Table 12 — HSN-wise summary of outward supplies. */
export const gstr1HsnSchema = z.object({
  num: z.number().int(),
  hsn_sc: z.string(),
  desc: z.string(),
  uqc: z.string(),
  qty: z.number(),
  txval: z.number(),
  iamt: z.number(),
  camt: z.number(),
  samt: z.number(),
  csamt: z.number(),
  rt: z.number(),
});

/**
 * Table 13 — documents issued.
 *
 * Cancelled invoices appear HERE and nowhere else. They keep their number and
 * are reported as cancelled, because reusing the number would create exactly
 * the gap the numbering design exists to prevent (docs/23 §5.2).
 */
export const gstr1DocIssuedSchema = z.object({
  doc_num: z.number().int(),
  doc_typ: z.string(),
  docs: z.array(
    z.object({
      num: z.number().int(),
      from: z.string(),
      to: z.string(),
      totnum: z.number().int(),
      cancel: z.number().int(),
      net_issue: z.number().int(),
    }),
  ),
});

export const gstr1ResponseSchema = z.object({
  gstin: z.string(),
  /** `MMYYYY`, the portal's period format. */
  fp: z.string(),
  from: z.string(),
  to: z.string(),
  b2b: z.array(gstr1B2bSchema),
  b2cl: z.array(gstr1B2clSchema),
  b2cs: z.array(gstr1B2csSchema),
  cdnr: z.array(gstr1CdnrSchema),
  hsn: z.object({ data: z.array(gstr1HsnSchema) }),
  doc_issue: z.object({ doc_det: z.array(gstr1DocIssuedSchema) }),
  /**
   * Not part of the portal payload — a reconciliation aid, so whoever files
   * can check the totals against their own books before uploading.
   */
  summary: z.object({
    invoiceCount: z.number().int(),
    cancelledCount: z.number().int(),
    creditNoteCount: z.number().int(),
    debitNoteCount: z.number().int(),
    totalTaxableValue: z.string(),
    totalCgst: z.string(),
    totalSgst: z.string(),
    totalIgst: z.string(),
    totalCess: z.string(),
    totalTax: z.string(),
    totalInvoiceValue: z.string(),
    /** Invoices excluded because they derive from SECONDARY orders. */
    excludedSecondaryCount: z.number().int(),
  }),
});

export type Gstr1Response = z.infer<typeof gstr1ResponseSchema>;

/**
 * GSTR-3B — the summary return.
 *
 * Only the outward-supply half is computable here. Table 4 (input tax credit)
 * needs purchase documents, which this system does not hold, so it is returned
 * as zeros with a note rather than silently omitted — an absent section reads
 * as "nothing to claim", which for most businesses is wrong.
 */
export const gstr3bResponseSchema = z.object({
  gstin: z.string(),
  ret_period: z.string(),
  from: z.string(),
  to: z.string(),
  sup_details: z.object({
    /** 3.1(a) — outward taxable supplies, other than zero-rated and exempt. */
    osup_det: z.object({
      txval: z.number(),
      iamt: z.number(),
      camt: z.number(),
      samt: z.number(),
      csamt: z.number(),
    }),
    /** 3.1(b) — zero-rated. */
    osup_zero: z.object({ txval: z.number(), iamt: z.number(), csamt: z.number() }),
    /** 3.1(c) — nil-rated and exempt. */
    osup_nil_exmp: z.object({ txval: z.number() }),
  }),
  /** 3.2 — inter-state supplies to unregistered persons, by place of supply. */
  inter_sup: z.object({
    unreg_details: z.array(z.object({ pos: z.string(), txval: z.number(), iamt: z.number() })),
  }),
  itc_elg: z.object({
    /** Always zero — see the note. */
    itc_avl: z.array(z.never()).default([]),
    note: z.string(),
  }),
  summary: z.object({
    invoiceCount: z.number().int(),
    creditNoteCount: z.number().int(),
    debitNoteCount: z.number().int(),
    /** Net of credit and debit notes — what the return actually declares. */
    netTaxableValue: z.string(),
    netTaxPayable: z.string(),
  }),
});

export type Gstr3bResponse = z.infer<typeof gstr3bResponseSchema>;

/** `2026-04-01` → `042026`, the portal's period format. */
export const toReturnPeriod = (date: string): string => {
  const [year = '', month = ''] = date.split('-');
  return `${month}${year}`;
};
