# 23 — Phase 8 Design: Finance

> Gate 1 (Design) for Phase 8. Written before any application code.
> New ADRs: **0015** (the party ledger is the source of truth), **0016** (invoice immutability is
> enforced by the database), **0017** (credit and debit notes share one table), **0018** (payment
> verification, not recording, is the financial event).
> Completion record: `24-phase-8-completion.md`.

---

## 1. What this phase actually is

Phase 7 ends at a dispatched shipment. Phase 8 turns that into money owed, money received, and a
return the government will accept.

```
Order ──approve──▶ Shipment ──dispatch──▶ │ Invoice ──issue──▶ LedgerEntry (DEBIT)
                                          │    │                     │
                                          │    ├── TaxNote ──────────┤ (CREDIT or DEBIT)
                                          │    │                     │
                                          │    └── Payment ──verify──┘ (CREDIT)
                                          │                           │
                                          │                     Outstanding · Aging · GSTR-1/3B
                                        Phase 8
```

This is the first phase where being wrong is not a bug but an offence. A gap in an invoice series,
a CGST/SGST split on an inter-state supply, a document issued under an unverified GSTIN — each of
those is a finding in an assessment, not a ticket. The design below is shaped almost entirely by
that: **wherever a control could be enforced either in a service or in the database, it is enforced
in the database.**

### What this phase does NOT do

It does not price anything. Every rupee on an invoice is copied from the order line that Phase 7
already snapshotted under ADR-0011. The one place `PricingService.quote()` is called is a *direct*
invoice — one raised with no originating order — and even then the result is snapshotted onto the
invoice line, never referenced.

It does not move stock. Dispatch did that. An invoice is a financial document about goods that have
already left.

## 2. Two answers from the owner

| # | Question | Answer | Consequence |
|---|---|---|---|
| **E1** | Hixaa's real GSTIN, PAN, CIN | **Not yet — build against placeholders** | `company.statutory.verified` stays `false`; `POST /invoices/:id/issue` refuses with `422 STATUTORY_IDENTITY_UNVERIFIED`. Everything up to and including the PDF preview works. Supplying the real numbers later is a settings write — no code changes, no migration |
| **E2** | Invoice number format | **`HTPL/INV/2026-27/00001`** | Requires a per-sequence separator (§4). Decided now because `INVOICE:2026-27` is still at `next_value = 1` — a gapless GST series cannot be renumbered after the fact |

**Assumption on E2, flagged and unblocking:** no manual GST invoices already exist for FY 2026-27.
If they do, `number_sequence.next_value` must be advanced past the last filed number before the
first DMS invoice is issued, or the DMS will duplicate a number the CA has already filed. The
column is a plain integer and the seed's `update` clause deliberately never resets it, so this is a
one-line correction — but it must happen *before* issue, not after.

### A defect found while answering E2

`NumberSequenceService.next()` joined prefix and counter with a hardcoded hyphen:

```ts
return `${sequence.prefix}-${padded}`;   // HTPL/INV/2026-27-00001
```

`docs/HANDOFF.md` §7 and `docs/12-recommendations.md` §E both documented the default as
`HTPL/INV/2026-27/00001`. The code has never produced that. It went unnoticed because the only
series exercised so far are `DIST-`, `CUST-`, `SO/`, `QT/`, `DC/` and `TRF-`, where a hyphen either
looks right or looks unremarkable. §4 fixes it.

## 3. Schema — migration 0010

Seven new models, one altered.

| Model | Purpose |
|---|---|
| **`Invoice`** + **`InvoiceLine`** | The tax invoice. Immutable once issued (ADR-0016) |
| **`TaxNote`** + **`TaxNoteLine`** | Credit and debit notes under CGST s.34 — one table, two types (ADR-0017) |
| **`Payment`** | A receipt. Recording and verification are separate acts (ADR-0018) |
| **`PaymentAllocation`** | Which receipt settled which invoice, and by how much |
| **`LedgerEntry`** | Append-only party ledger — the source of truth for what is owed (ADR-0015) |
| `NumberSequence` | **altered**: gains `separator` |

### 3.1 Why there is no `party_balance` table

ADR-0002 established ledger + derived balance for stock, and `stock_balance` exists because a stock
figure is read on every order line and needs `SELECT … FOR UPDATE` on a hot row.

A party balance is not that. It is read on a statement screen and inside a credit check — tens of
rows, indexed on `(party_type, party_id)`. A materialised balance would need the same locking
discipline as `stock_balance` for a fraction of the benefit, and it would introduce a second place
that could disagree with the ledger about what a distributor owes.

**Decision: no balance table.** The party balance is `SUM(debit) − SUM(credit)` over `LedgerEntry`.
Per-invoice outstanding *is* materialised — on the invoice itself (§3.2) — because aging asks "how
old is each unpaid invoice", which the ledger cannot answer without reconstructing allocations.

This is a deliberate divergence from the ADR-0002 pattern, recorded rather than silently taken.

### 3.2 Invoice money columns

`grandTotal` is frozen at issue. Three columns move afterwards:

| Column | Maintained by | Meaning |
|---|---|---|
| `amountPaid` | `PaymentAllocation` writes | Cash + TDS allocated to this invoice |
| `amountCredited` | `TaxNote` issues | Value reversed by credit notes, net of debit notes |
| `amountOutstanding` | **BEFORE trigger** | `grandTotal − amountPaid − amountCredited` |

`amountOutstanding` is trigger-maintained rather than `GENERATED`, per HANDOFF §4.13 — a GENERATED
column shows up as drift and the next `migrate dev` would propose dropping it. A BEFORE trigger is
behaviourally identical and looks like an ordinary column to Prisma.

It is a stored column rather than a query because the credit check and the aging report both filter
on it, and `WHERE amount_outstanding > 0` with an index is the difference between a scan and a seek.

### 3.3 Constraints the database enforces itself

Six, in migration 0010's raw SQL:

1. **`ledger_entry` is append-only.** A trigger rejects `UPDATE` and `DELETE` outright — the same
   guarantee `stock_ledger_entry` has had since migration 0007. A ledger you can edit is not a
   ledger.
2. **`ledger_entry` has exactly one side.** `CHECK ((debit = 0) <> (credit = 0))`. A row with both
   or neither is meaningless, and the check is cheaper than the reconciliation that finds it later.
3. **An issued invoice is frozen.** A trigger rejects any `UPDATE` to `invoice` that changes
   `number`, `invoice_date`, `place_of_supply_state_code`, `supplier_state_code`, `distributor_id`,
   `customer_id`, or any of the eleven money columns, when `OLD.status <> 'DRAFT'`. Payment-tracking
   columns and `status` itself remain writable — that is what settlement is. See ADR-0016.
4. **An issued invoice's lines are frozen.** `UPDATE` and `DELETE` on `invoice_line` are rejected
   when the parent invoice is not `DRAFT`.
5. **A payment cannot be over-allocated.** `CHECK` plus a service-level lock: the sum of a payment's
   allocations may not exceed `amount + tds_amount`. The CHECK catches the single-row case; the
   `SELECT … FOR UPDATE` in `PaymentsService.allocate` catches the concurrent one.
6. **An invoice cannot be over-settled.** `CHECK (amount_paid + amount_credited <= grand_total)`.
   The one that would otherwise let a double-allocated payment quietly create a negative receivable.

### 3.4 Indexes

| Index | Justifies |
|---|---|
| `invoice (status, due_date)` partial `WHERE amount_outstanding > 0` | The aging report and the overdue sweep — the two hot reads |
| `invoice (distributor_id, status)` | Credit exposure, per distributor |
| `invoice (invoice_date, id)` | GSTR-1 extraction over a period |
| `ledger_entry (party_type, party_id, entry_date, id)` | Statement of account, in order, with a stable tiebreak |
| `payment_allocation (invoice_id)` | "What settled this invoice" |
| `tax_note (original_invoice_id)` | "What corrected this invoice" |

The aging index is partial. Partial indexes escape Prisma's drop-proposal (HANDOFF §4.13) *and* it
is the right index anyway — a fully settled invoice is never in an aging bucket.

## 4. Numbering — the separator, and why it changes for some series only

`NumberSequence` gains `separator String @default("-")`, and `next()` becomes:

```ts
return `${sequence.prefix}${sequence.separator}${padded}`;
```

The default preserves every existing series exactly. The seed then sets `/` for the four financial
series and leaves the rest alone:

| Series | Separator | First number | Why |
|---|---|---|---|
| `INVOICE` | `/` | `HTPL/INV/2026-27/00001` | E2. None issued — `next_value` is 1 |
| `CREDIT_NOTE` | `/` | `HTPL/CRN/2026-27/00001` | New series |
| `DEBIT_NOTE` | `/` | `HTPL/DBN/2026-27/00001` | New series |
| `PAYMENT` | `/` | `RCPT/2026-27/00001` | None issued |
| `ORDER`, `QUOTATION`, `SHIPMENT` | `-` *(unchanged)* | — | Numbers already exist in the hyphen shape |
| `DISTRIBUTOR`, `CUSTOMER`, `TRANSFER` | `-` *(unchanged)* | — | Internal codes; `DIST-00001` reads correctly |

**Why not make everything consistent.** Because `SO/2026-27-00003` followed by `SO/2026-27/00004`
is a discontinuity *within* a series, and a discontinuity within a series is exactly what an auditor
asks about. Consistency across document types is cosmetic; consistency within one is the point.
Recorded here so the mixed house style reads as a decision rather than an oversight.

Credit and debit notes get **separate series**, not a shared one. CGST s.34 read with Rule 46(b)
requires a consecutive serial number per document type; sharing one series between two document
types produces gaps in both.

## 5. The invoice lifecycle

```
                    ┌──────────────────── cancel (narrow) ─────────────┐
                    │                                                  ▼
  DRAFT ──issue──▶ ISSUED ──allocate──▶ PARTIALLY_PAID ──allocate──▶ PAID
    │                 ▲                        │                       │
    │                 └────────────────────────┴───────────────────────┘
    │                              (a credit note can move any of these back)
    └── delete (DRAFT only, no number consumed)
```

`OVERDUE` is **not a status.** It is `due_date < today AND amount_outstanding > 0`, computed at read
time. A status that only becomes correct when a nightly job runs is a status that is wrong between
midnight and the job — and the one screen that matters, "who owes me money right now", is the screen
that would be wrong. The `invoice.overdue` domain event still fires from a scheduled sweep, because
a *notification* genuinely is a point-in-time act; the aging report never reads it.

### 5.1 The issue gate — seven refusals

`POST /invoices/:id/issue` is where this phase's legal exposure concentrates. It refuses, in order:

| # | Refusal | Code | Origin |
|---|---|---|---|
| 1 | `company.statutory.verified` is false | `STATUTORY_IDENTITY_UNVERIFIED` | **E1**, obligation from `docs/22` §7 |
| 2 | The invoice derives from a `SECONDARY` order | `SECONDARY_ORDER_NOT_INVOICEABLE` | ADR-0014 §6, obligation from `docs/22` §7 |
| 3 | Any line's GST rate came from `PRODUCT_SNAPSHOT` | `TAX_RATE_NOT_AUTHORITATIVE` | ADR-0008, obligation from `docs/22` §7 |
| 4 | A B2B counterparty has a malformed GSTIN | `COUNTERPARTY_GSTIN_INVALID` | Rule 46(f) |
| 5 | The invoice has no lines, or a zero grand total | `EMPTY_INVOICE` | — |
| 6 | The invoice date is in the future | `FUTURE_DATED` | Added during implementation — a tax invoice documents a supply already made, and a forward-dated one lands in the wrong return period |
| 7 | The invoice is not `DRAFT` | `INVALID_STATE_TRANSITION` | — |

All seven throw `InvoiceIssueRefusedError` (HTTP 422) carrying the code in
`extensions.refusal`, because the remedy differs by gate: an unverified GSTIN is fixed in Settings
by an admin, a missing tax rate in the tax table by finance. One code with different prose would
leave the UI guessing which screen to send the user to.

Refusal 1 is checked first because it is the one that will actually fire today, and a caller
deserves the blocking reason rather than the first of six.

**How refusal 3 is evaluated.** The order line snapshots `gstRate` but not where the rate came from
— `taxRateSource` lives on the pricing engine's *trace*, which is not persisted. Rather than adding
a column that would be null for every Phase 7 row, the invoice re-asks the question at issue time:
`PricingService.resolveTaxRate(hsnSacCode, invoiceDate)` (made public for this — reuse, not a second
implementation). No covering `TaxRate` row on the invoice date means the rate is not authoritative,
and the answer is stored on `invoice_line.tax_rate_id` so the decision is on the record.

This is stronger than checking a persisted flag would have been: it validates the rate against the
*invoice's* date, which is the date that matters legally, rather than against the date the order was
priced.

### 5.2 Cancellation, and why it is narrow

An issued invoice cannot be deleted. It can be cancelled only when all four hold:

- no payment allocated against it,
- no tax note references it,
- it is still within the financial year of issue,
- and no IRN has been generated (always true in v1 — see §9).

Anything else is corrected by credit note. **A cancelled invoice keeps its number** and still
appears in GSTR-1 table 13 (documents issued) in the cancelled count — reusing the number would
create the gap the whole numbering design exists to prevent.

## 6. The ledger — one table, six entry types

`LedgerEntry` is append-only and carries exactly one of `debit` or `credit`.

| Entry type | Side | Written when |
|---|---|---|
| `OPENING_BALANCE` | either | A party is onboarded with an existing balance |
| `INVOICE` | debit | An invoice is issued |
| `CREDIT_NOTE` | credit | A credit note is issued |
| `DEBIT_NOTE` | debit | A debit note is issued |
| `PAYMENT` | credit | A payment is **verified** (ADR-0018), not when recorded |
| `TDS` | credit | Tax deducted at source, alongside the payment that carries it |
| `WRITE_OFF` | credit | A balance is written off, with a reason and an approver |
| `ADJUSTMENT` | either | A manual correction, always with a reason |

Sign convention: **debit increases what the party owes Hixaa.** A positive running balance is a
receivable. This is stated once here and asserted in a unit test, because a sign convention that
lives only in people's heads inverts itself within a year.

TDS is a separate entry rather than being folded into the payment. A customer paying ₹98,000 against
a ₹1,00,000 invoice having deducted ₹2,000 has settled the invoice in full — the ledger must show
₹98,000 cash and ₹2,000 TDS, because the ₹2,000 is recoverable from the government and the ₹98,000
is not. One combined ₹1,00,000 credit would lose that.

## 7. Payments — record, verify, allocate

Three distinct acts, deliberately (ADR-0018):

1. **Record** (`payment:create`) — someone says a receipt arrived. Writes a `Payment` in `RECORDED`.
   **No ledger entry.** A claimed receipt is not a receipt.
2. **Verify** (`payment:verify`) — someone *else* confirms it against the bank. Writes the
   `PAYMENT` (and `TDS`) ledger entries. `SEGREGATION_OF_DUTIES` already forbids one role holding
   both permissions; the service additionally refuses when `verifiedById === recordedById`, because
   a person can hold two roles.
3. **Allocate** (`payment:allocate`) — apply a verified payment across one or more invoices.

**Allocation requires `VERIFIED`.** A cheque recorded on the 1st and cleared on the 5th leaves the
invoice outstanding until the 5th, which is what actually happened. Allowing allocation at `RECORDED`
would let an unconfirmed receipt reduce a real receivable and inflate available credit — the exact
exposure the segregation rule exists to prevent.

Over-allocation is refused at three levels: a Zod refinement on the DTO, a `SELECT … FOR UPDATE` on
the payment row inside the transaction, and the `CHECK` constraint of §3.3. The lock is the real
control; the other two make the failure fast and the invariant explicit.

`BOUNCED` reverses: the ledger entries are *contra-posted* (a new opposing entry), never deleted.

## 8. Outstanding and aging

Buckets `0–30 / 31–60 / 61–90 / 90+`, measured from `due_date`, not `invoice_date` — an invoice on
Net 45 terms is not overdue on day 31.

`due_date` is computed at issue from the order's `paymentTermsCode` against `finance.paymentTerms`
(seeded in Phase 5), and **snapshotted**. Payment terms are editable; an invoice's due date is not.

### The Phase 7 obligation this discharges

`OrderApprovalService.checkCredit` has carried this since Phase 7:

```ts
// Phase 8: outstanding invoice balance joins here. Named rather than
// inlined as zero so the addition is visible when it becomes real.
const outstandingInvoices = Money.zero();
```

It becomes a sum over `invoice.amountOutstanding` for the distributor's non-draft, non-cancelled
invoices. As predicted, one line — the shape was right.

**Consequence worth stating plainly:** every distributor's available credit drops the moment Phase 8
ships, because exposure now includes money genuinely owed that the system previously ignored. That
is a correction, not a regression, and orders that newly require a credit override are orders that
always should have.

## 9. GST returns and the e-Invoice seam

`GET /gst/gstr1` and `GET /gst/gstr3b` return JSON in the portal's own shape, over a period.

GSTR-1 sections built: **4** (B2B), **5** (B2CL), **7** (B2CS), **9B** (CDNR/CDNUR), **12** (HSN
summary), **13** (documents issued, including cancelled counts).

Classification at issue, snapshotted onto `invoice.supplyType`:

| Supply type | Rule |
|---|---|
| `B2B` | Counterparty has a GSTIN |
| `B2CL` | No GSTIN, inter-state, invoice value above the B2CL threshold |
| `B2CS` | No GSTIN, everything else |
| `EXPORT`, `SEZ` | Place of supply `96`/`97`, or an SEZ counterparty flag |

The B2CL threshold is a **setting** (`finance.gst.b2clThreshold`, default `100000`), not a constant.
It moved from ₹2.5 lakh to ₹1 lakh on 1 Nov 2024, and a statutory threshold that has already changed
once will change again. A constant would require a deploy; a setting requires a form.

**SECONDARY orders are excluded from every section.** A sell-out is the distributor's supply to
their customer — Hixaa's GST liability ended at the sell-in invoice. Enforced at the query, and
separately at issue (refusal 2), so neither one alone is load-bearing.

**e-Invoice / e-Way Bill:** interface + columns, no live calls. `EInvoiceAdapter` and
`EWayBillAdapter` are declared with a `NoopAdapter` bound by default; the `irn`, `ackNumber`,
`ackDate`, `signedQrCode`, and `ewayBillNumber` columns exist so adopting a GSP later is a service
binding rather than a migration on a table holding legal documents. Following the ClamAV/S3
precedent, a non-noop adapter **throws at boot** rather than silently degrading.

Hixaa's turnover does not currently require e-invoicing. The seam exists because the threshold has
fallen every year since 2020.

## 10. API surface

```
GET    /invoices                       list, scoped, filterable by status/distributor/overdue
GET    /invoices/:id                   detail — lines, allocations, notes, ledger effect
GET    /invoices/:id/pdf               tax invoice PDF
POST   /invoices                       draft, ad-hoc (calls PricingService.quote)
POST   /invoices/from-order/:orderId   draft, copying the order's snapshot
POST   /invoices/from-shipment/:id     draft, for what actually shipped
PATCH  /invoices/:id                   DRAFT only
DELETE /invoices/:id                   DRAFT only — no number was consumed
POST   /invoices/:id/issue             ← §5.1
POST   /invoices/:id/cancel            ← §5.2
POST   /invoices/:id/send              queues the PDF email through the outbox

GET    /credit-notes  ·  POST /credit-notes  ·  GET /credit-notes/:id
POST   /credit-notes/:id/issue         ·  GET /credit-notes/:id/pdf
GET    /debit-notes   ·  POST /debit-notes   ·  …          same service, type fixed by the route

GET    /payments      ·  GET /payments/:id  ·  POST /payments  ·  PATCH /payments/:id
POST   /payments/:id/verify            ·  POST /payments/:id/allocate
DELETE /payments/:id/allocations/:allocationId
POST   /payments/:id/bounce

GET    /ledger/:partyType/:partyId     statement of account with a running balance
GET    /outstanding                    aging, all parties
GET    /outstanding/:partyType/:partyId

GET    /gst/gstr1?from=&to=            ·  GET /gst/gstr3b?from=&to=
```

Credit and debit notes get separate routes over one service so the API speaks the language a CA
uses, while the storage stays one shape (ADR-0017).

## 11. Scoping

`invoice`, `payment`, `taxNote`, and `ledgerEntry` join `SCOPE_REGISTRY`. Invoices and payments
reach a territory through the distributor or the customer — the same `viaDistributorOrCustomer`
strategy Phase 7 built for orders, reused unchanged.

`ledgerEntry` is the awkward one: it has `partyType`/`partyId`, not a relation. A new
`byPartyRelation()` strategy resolves the party ids the caller can see and matches on them.

Per HANDOFF §4.14, refusal is proved with an account that is **scoped and holds the permission** —
`west.accountant@hixaa.test`, seeded for this phase (`ACCOUNTS_EXECUTIVE`, WEST zone). Testing with
a read-only account would return 403 on permission grounds and say nothing about row scoping, which
is the blind spot that hid a real bug for two phases.

## 12. Reuse — what Phase 8 must not rebuild

| Existing | Used for |
|---|---|
| `GstCalculator` | Every tax figure, including partial-quantity invoices and note lines |
| `PricingService.quote()` | Direct invoices only; order-derived invoices copy the snapshot |
| `PricingService.resolveTaxRate()` | Issue refusal 3 — made public rather than reimplemented |
| `NumberSequenceService` | All four financial series, gapless, inside the issue transaction |
| `DocumentRendererService` | Invoice and note PDFs — siblings of the quotation, not copies |
| `amountInWords`, `formatIndianDigits` | The PDF's rupee rendering |
| `Money` | Every arithmetic operation; `allocateByWeights` for spreading a payment across lines |
| `viaDistributorOrCustomer` | Invoice and payment scoping |
| `OutboxService`, `AuditService` | Every side effect and every state change |

## 13. Verification plan

Typecheck proves nothing here — HANDOFF §9. The gate is a real database and real HTTP.

1. Boot the API. Seed. Confirm migration 0010 applied and `migrate diff` reports empty.
2. Build an order → approve → dispatch, as Phase 7 does today.
3. `POST /invoices/from-order/:id` → 201 DRAFT, totals equal the order's to the paisa.
4. `POST /invoices/:id/issue` → **422, statutory unverified.** The E1 gate, proven by refusal.
5. Set `company.statutory.verified = true` via the settings API. Issue → 201, number
   `HTPL/INV/2026-27/00001`. Check `number_sequence.next_value` is now 2.
6. `UPDATE invoice SET grand_total = 1 WHERE …` in psql → **rejected by trigger.** ADR-0016 proven
   at the layer that actually holds it.
7. Record a payment → verify with a *different* user → allocate. Check `amount_outstanding` moved
   and two `ledger_entry` rows exist with the right sides.
8. Verify with the *same* user who recorded → **refused.**
9. Over-allocate → refused. Then over-allocate two payments concurrently → refused by the lock.
10. Issue a credit note → invoice reopens, ledger credits, `amount_credited` moves.
11. `GET /outstanding` → the invoice lands in the right bucket for its due date.
12. `GET /gst/gstr1` → the invoice appears in table 4; a SECONDARY-derived one appears nowhere.
13. As `west.accountant@hixaa.test`, read and write an out-of-zone invoice → **404 on both.**
14. `pnpm verify` green.

Steps 4, 6, 8, 9 and 13 are the ones that matter. A control is not verified until something is
refused (HANDOFF §4.4).

## 14. Deferred, with reasons

| Deferred | Why |
|---|---|
| **Create/edit forms** | Consistent with every phase so far — the UI is read-only and mutations are curl-verified. This is the largest outstanding frontend debt, tracked in HANDOFF §8, not a Phase 8 decision |
| **Live GSP calls** for e-Invoice/e-Way | No registration, no turnover requirement. Adapter interface and columns exist; a non-noop binding throws at boot |
| **GSTR-2A/2B reconciliation** | Purchase-side. Phase 8 is sales-side; there is no purchase document in the schema yet |
| **Multi-currency** | Everything is INR. `finance.defaults.currency` exists; nothing reads it as a variable yet |
| **Automatic overdue status flip** | Deliberate — see §5. The event fires; the status does not exist |
| **Recurring invoices / AMC billing** | Real for Hixaa's service lines, but it is a scheduling problem on top of invoicing, and invoicing has to exist first |
| **Write-off approval workflow** | The `WRITE_OFF` entry type and permission exist; the approval chain around it is Phase 9 alongside the other financial approvals |
