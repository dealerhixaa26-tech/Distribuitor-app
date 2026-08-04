# ADR-0017 — Credit and debit notes share one table, with separate number series

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

Section 34 of the CGST Act defines two correction documents:

- A **credit note** reduces what was charged — goods returned, a rate overcharged, a deficiency.
- A **debit note** increases it — a rate undercharged, a quantity under-billed.

They are the only lawful way to correct an issued invoice (ADR-0016), so Phase 8 needs both.

Structurally they are the same document. Both reference an original invoice, both carry lines with
HSN/SAC, taxable value and a GST split, both need a reason, both need a gapless serial number, both
land in GSTR-1 table 9B, and both post to the party ledger. The only differences are the sign of the
ledger effect and the word printed at the top.

Three options:

1. **Two tables** — `credit_note` and `debit_note`, near-identical, plus two line tables.
2. **One table with a type discriminator.**
3. **Fold them into `Invoice`** with a document-type column.

Option 3 is tempting — GSTR-1 treats them all as outward supplies — and wrong. An invoice has
payment allocation, aging, a due date, and a settlement lifecycle. A note has none of that; it
settles by adjusting an invoice. Merging them would put eight nullable columns on every row and make
`WHERE status = 'PAID'` a question with no meaning for half the table.

Option 1 is what most ERPs do, and it is how the two implementations drift. The tax calculation, the
PDF, the GSTR-1 mapping, and the ledger posting are identical; duplicating them guarantees that a
rounding fix lands in one and not the other. This project has already recorded that failure mode
twice — ADR-0007 (one pricing pipeline) and `SalesPricingHelper`, which exists precisely so a
quotation and its order cannot disagree.

## Decision

**One model, `TaxNote`, with `type: CREDIT | DEBIT`. Separate number series. Separate routes.**

### 1. The model is named for what the law calls the category, not for one of its members

```prisma
enum TaxNoteType { CREDIT  DEBIT }

model TaxNote {
  type              TaxNoteType
  number            String @unique
  originalInvoiceId String
  reason            TaxNoteReason
  ...
}
```

A table named `credit_note` holding debit notes is the kind of thing that reads fine to its author
and confuses everyone afterwards. `tax_note` is neutral and both members belong in it.

### 2. Separate number series

`CREDIT_NOTE` → `HTPL/CRN/2026-27/00001`, `DEBIT_NOTE` → `HTPL/DBN/2026-27/00001`.

Rule 46(b) read with s.34 requires a consecutive serial number **per document type**. A shared
series would produce gaps in both when read separately — which is how they are read, because GSTR-1
reports them separately.

Sharing storage while separating numbering is the whole shape of this decision: the *document* is
one thing, the *series* is two.

### 3. Separate routes over one service

```
POST /credit-notes   →  TaxNotesService.create({ ...dto, type: 'CREDIT' })
POST /debit-notes    →  TaxNotesService.create({ ...dto, type: 'DEBIT'  })
```

The API speaks the language a CA uses. The type is fixed by the route rather than accepted in the
body, so a client cannot post a debit note to the credit-note endpoint and no request can be
ambiguous about which series it consumes.

### 4. The sign lives in exactly one place

```ts
const side = note.type === 'CREDIT' ? 'credit' : 'debit';
```

One expression, in `TaxNotesService.postToLedger`. Everything else — tax computation via
`GstCalculator`, the PDF via `DocumentRendererService`, the GSTR-1 9B mapping — is type-agnostic and
therefore cannot be right for one type and wrong for the other.

`invoice.amount_credited` is signed accordingly: a credit note increases it, a debit note decreases
it. So the invariant `amount_outstanding = grand_total − amount_paid − amount_credited` holds for
both without a branch.

### 5. A note cannot exceed what it corrects

A credit note's value may not take `amount_credited` above `grand_total − amount_paid`. Refused in
the service and backed by the `CHECK` of ADR-0015 §4. Crediting more than was invoiced is not a
correction; it is a discount that should have been on the invoice.

## Consequences

**Good.** One tax calculation, one PDF builder, one ledger posting, one GSTR-1 mapping — a fix to
any of them is a fix to both document types. Numbering stays lawful and separate. The API surface
still reads the way an accountant expects.

**Costs.** Every query against notes must filter on `type`, and forgetting to do so returns both —
mitigated by the service taking `type` as a required argument on every method rather than as an
optional filter. Anyone reading the schema in isolation must notice the discriminator before
assuming `tax_note` means credit notes.

**Revisit if** the two document types diverge in structure — most plausibly if a credit note ever
needs to reference multiple invoices, which the current model forbids by design.
