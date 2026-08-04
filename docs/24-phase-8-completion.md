# 24 — Phase 8 Completion: Finance

> Design: `23-phase-8-design.md`. ADRs **0015**–**0018**.
> Migrations **0010**, **0011**, **0012**. `pnpm verify` green.

---

## 1. What now exists

A tax invoice can be raised from an order, refused while the company's GST registration is
unverified, issued under a gapless statutory number, paid in parts with TDS, corrected by credit
note, aged into buckets, and exported into GSTR-1 — with the ledger balancing at every step.

That is the roadmap's exit criterion for Phase 8, and it has been driven end to end against a real
database rather than asserted.

| | |
|---|---|
| Models added | `Invoice`, `InvoiceLine`, `TaxNote`, `TaxNoteLine`, `Payment`, `PaymentAllocation`, `LedgerEntry` |
| Migrations | 0010 (finance), 0011 (delete guards), 0012 (ledger party as FKs) |
| Endpoints | 35 new (206 total) |
| Tests | 346 total, up from 295 — 185 contracts + 161 API |
| Size | ~50,270 source lines · 77 tables · 12 migrations |

### The two answers this phase was blocked on

**E1 — statutory identity.** Answered *"not yet, build against placeholders."* The refusal path is
built and proven: `POST /invoices/:id/issue` returns `422 INVOICE_ISSUE_REFUSED` with
`extensions.refusal = STATUTORY_IDENTITY_UNVERIFIED` while `company.statutory.verified` is false.
Supplying the real GSTIN, PAN and CIN later is a settings write — **no code change, no migration**.
The verification run set a checksum-valid placeholder to prove the far side of the gate, then the
gate itself was re-proven.

**E2 — invoice number format.** Answered `HTPL/INV/2026-27/00001`, and that is exactly what the
first issued invoice carries. Getting there required a fix described in §3.

## 2. The seven refusals, each proven by execution

`docs/23` §5.1. A control is not verified until something is refused (HANDOFF §4.4).

| Refusal | Proven |
|---|---|
| Statutory identity unverified | 422, `STATUTORY_IDENTITY_UNVERIFIED` |
| SECONDARY order not invoiceable | 409 at draft **and** 422 at issue — two independent gates |
| Tax rate not authoritative | Re-resolved against the invoice date via `PricingService.resolveTaxRate()` |
| Counterparty GSTIN malformed | Checksum validated; a hand-written GSTIN was rejected during the run |
| Empty invoice | No lines, or zero value |
| Future-dated | Added during implementation — a tax invoice documents a supply already made |
| Not DRAFT | See §3, where this one was initially wrong |

## 3. Three bugs found by execution after a clean typecheck

The pattern HANDOFF §9 describes, again. All three typechecked.

### 3.1 The invoice number never matched its documentation

`NumberSequenceService.next()` joined prefix and counter with a hardcoded hyphen, so the invoice
series would have produced `HTPL/INV/2026-27-00001` — while `HANDOFF` §7 and
`docs/12-recommendations.md` §E both documented `HTPL/INV/2026-27/00001`. It went unnoticed because
every series exercised before Phase 8 (`DIST-`, `CUST-`, `SO/`, `QT/`, `DC/`, `TRF-`) looks
unremarkable with a hyphen.

Caught while answering E2 — **before the first invoice existed**, which is the only moment it could
be fixed. `NumberSequence` gained a per-sequence `separator`. The four financial series use `/`;
`ORDER`, `QUOTATION` and `SHIPMENT` keep `-` because numbers already exist in that shape, and a
discontinuity *within* a series is what an auditor asks about.

### 3.2 Issued documents could be DELETED

Migration 0010's triggers guarded `UPDATE` and left `DELETE` wide open. `DELETE FROM invoice`
removed an ISSUED document without complaint — strictly worse than editing one, because it destroys
the gapless series rather than falsifying a figure in it. The same hole existed on `tax_note` and
on `payment`.

Found by running the psql script that was supposed to *confirm* the triggers worked; the cleanup
`DELETE` at the end succeeded when it should not have. Migration **0011** closes it, kept separate
from 0010 so the history records honestly that it was missed.

### 3.3 Re-issuing a PAID invoice 500'd and burnt a number

`issue()` guarded on `canTransitionInvoice(status, 'ISSUED')`. That table legitimately allows
`PAID → ISSUED` — a credit note offsetting everything paid leaves an invoice issued and unsettled
again, so the *status* must be able to travel back. But that is a settlement movement, not
permission to run the ISSUE *action* twice.

So re-issuing a PAID invoice passed the check, consumed a second statutory number, and then died on
the immutability trigger: a 500, with a number burnt out of the series. Now guarded on
`status !== 'DRAFT'` explicitly. The two concepts read identically at the call site, which is why
the unit test asserting the transition table needed a comment explaining that they are different.

## 4. Where the controls live

ADR-0016's argument is that a service check protects only the code path it sits on, and this
codebase has twice shipped a control that typechecked and did nothing. So the guarantees are in the
database. Fifteen were exercised directly in psql:

- `ledger_entry` rejects `UPDATE` and `DELETE` — the balance cannot be edited into agreement
- `CHECK ((debit = 0) <> (credit = 0))` — no row with both sides or neither
- An ISSUED invoice's 21 identity and money columns are frozen; settlement columns stay writable
- `amount_outstanding` is trigger-derived, so it cannot drift from its own inputs
- `amount_paid + amount_credited <= grand_total` — no negative receivable
- An ISSUED invoice cannot be deleted; a DRAFT can
- A VERIFIED payment's amount and party are frozen; `BOUNCED` is the correction path
- Exactly one counterparty per invoice, payment and ledger row

**`invoice-immutability.spec.ts` reads the trigger's column list back out of the migration and
compares it against the Prisma model.** Adding a money column to `Invoice` without freezing it fails
the build. That was ADR-0016's stated mitigation; it is real rather than aspirational.

## 5. The four Phase 7 obligations, discharged

| Obligation | Status |
|---|---|
| Exclude SECONDARY from invoicing and GSTR-1 | ✅ Refused at draft, at issue, and at the GSTR-1 query. The return reports `excludedSecondaryCount` so a silent exclusion is distinguishable from a missing row |
| Refuse to ISSUE while statutory unverified | ✅ First of the seven refusals |
| Refuse to ISSUE against `PRODUCT_SNAPSHOT` tax | ✅ Re-asked against the **invoice's** date via `PricingService.resolveTaxRate()`, made public rather than reimplemented. Stronger than a persisted flag: it validates the rate in force when the supply is documented |
| Add outstanding invoices to credit exposure | ✅ One line, as predicted |

The credit change was proven to alter behaviour, not merely to compile. With a ₹15,00,000 limit,
₹9,91,200 of open orders and ₹99,120 outstanding, headroom fell from ₹5,08,800 to ₹4,09,680. An
order of ₹4,95,600 — which would have been approved in Phase 7 — is now refused.

> **This will be felt.** Every distributor's available credit drops the moment this ships, because
> exposure now includes money genuinely owed that the system previously ignored. That is a
> correction. Orders that newly need an override are orders that always should have.

## 6. Scoping, proven with an account that can actually write

`invoice`, `payment`, `taxNote` and `ledgerEntry` are registered in `SCOPE_REGISTRY`.

Per HANDOFF §4.14, refusal was proven with **`west.accountant@hixaa.test`** — territory-scoped *and*
holding `invoice:create` / `payment:create`, so a refusal is unambiguously a scope refusal rather
than a permission one. Against a Tamil Nadu invoice: **404 on read, on write, and on delete**, while
the same account reads its own zone's invoice successfully.

`finance.manager@hixaa.test` was also seeded, because ADR-0018's segregation cannot be demonstrated
with fewer than two accounts: one records a receipt, a different one verifies it.

### The ledger's columns had to be reshaped for this

`ledger_entry` shipped in 0010 with `party_type` + `party_id`. That reads well and **cannot be
scoped**: `party_id` deliberately points at one of two tables, so it has no relation for the scope
extension to nest through, and Prisma offers no correlated subquery. The strategy first written for
it referenced `EffectiveAccess` fields that do not exist — it would have failed closed on every read.

Migration **0012** makes the party two nullable foreign keys with a CHECK that exactly one is set —
the shape `invoice` and `payment` already use — so `viaDistributorOrCustomer()`, written for orders
in Phase 7, applies unchanged. The `DISTRIBUTOR | CUSTOMER` vocabulary survives in the API; the
service derives it from the columns.

## 7. Reuse

Nothing was rebuilt. `GstCalculator` computes every tax figure including partial-quantity and note
lines; `SalesPricingHelper` prices direct invoices through the same path a quotation uses;
`NumberSequenceService` serves four financial series; `DocumentRendererService` gives the invoice
PDF its page setup, fonts, styles and letterhead; `amountInWords` and `formatIndianDigits` render
the rupee figures; `viaDistributorOrCustomer` scopes three new models.

The invoice PDF was checked with `pdftotext`, not assumed: it carries the words TAX INVOICE, the
number, both GSTINs, place of supply with its state name, HSN per line, rate-wise CGST/SGST columns,
the total in Indian words, and a signature block — Rule 46's requirements. A DRAFT renders with a
DRAFT watermark, no number, and a footer saying it is not a tax invoice.

## 8. Deliberately deferred

| Deferred | Why |
|---|---|
| **Create/edit forms** | The UI stays read-only, as in every phase so far. Invoices, payments and the aging report have list and detail pages; all mutations are curl-verified. Still the largest frontend debt (HANDOFF §8) |
| **Live GSP calls** for e-Invoice / e-Way Bill | No registration, no turnover requirement. Columns and adapter seam exist so adopting one is a service binding, not a migration on a table holding legal documents |
| **GSTR-2A/2B reconciliation** | Purchase-side. GSTR-3B table 4 is returned as zeros **with an explicit note** rather than omitted — an absent ITC section reads as "nothing to claim", which for most businesses is wrong |
| **Automatic overdue status** | There is deliberately no `OVERDUE` status. It is computed from the due date at read time, so it is never stale between midnight and a nightly job |
| **Recurring / AMC billing** | Real for Hixaa's service lines, but a scheduling problem on top of invoicing |
| **Write-off approval chain** | The entry type and permission exist; the approval workflow belongs with Phase 9's other financial approvals |

## 9. Two things the owner should know

**The E2 assumption is still an assumption.** Phase 8 was built assuming **no manual GST invoices
exist for FY 2026-27**. If any do, `number_sequence.next_value` for `INVOICE:2026-27` must be
advanced past the last filed number *before* the first real invoice is issued — the seed's `update`
clause never resets it, so this is a one-line correction, but only beforehand.

**Seed data inconsistency, pre-existing.** `DIST-00002` is named "Chennai Process Controls", sits in
the Tamil Nadu territory, and carries a GSTIN beginning `29` (Karnataka). Place of supply is derived
from the GSTIN, so its invoices show Karnataka. The tax logic is correct — inter-state, IGST only —
but the seeded fixture is self-contradictory. Harmless in dev; worth fixing before anyone treats it
as an example.

## 10. Verification record

`scripts/phase-8-smoke.sh` — 19 checks against a running API, all passing. It exists in the repo so
the next phase can re-run it rather than trusting this document.

Covered: both Phase 7 obligations, three immutability refusals, four scope refusals (read, write,
delete, and a positive control), six segregation and settlement behaviours, and four report
endpoints.

Beyond the script, driven manually during the phase: draft totals matching the order to the paisa;
the E1 gate before and after verification; `HTPL/INV/2026-27/00001` allocated and the sequence
advanced; ledger debit posted in the issue transaction; cash and TDS credited separately; the
invoice closing at exactly zero after 900,000 paid + 91,200 credited against 991,200; over-allocation
refused; aging landing a 45-day-late invoice in 31–60; GSTR-1 tables 4/9B/12/13 populated with
`excludedSecondaryCount: 0`; and GSTR-3B netting the credit note (840,000 − 77,288.14 = 762,711.86).

`pnpm verify` green: lint, typecheck, 346 tests, build.
