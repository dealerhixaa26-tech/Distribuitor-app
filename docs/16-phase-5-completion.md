# 16 — Phase 5: Distributors — Completion Record

> Status: **Complete and verified**, with two seams deliberately left for Phase 4.
> Built out of roadmap order at your request; see §5.

---

## 1. Gate results

| # | Gate | Result |
|---|---|---|
| 1 | **Design** | Lifecycle FSM declared as data; KYC gate specified before implementation |
| 2 | **Database** | Migration 0005: distributor, contacts, KYC, notes, agreements (36 tables total) |
| 3 | **API** | 20 endpoints — CRUD, lifecycle, credit, contacts, KYC, notes, agreements |
| 4 | **Backend** | Gapless code allocation, encrypted bank details, KYC-gated approval, second scoped entity |
| 5 | **Frontend** | Distributor list with filters and the 360 detail view |
| 6 | **Tests** | 107 passing (80 contracts · 77 API — 15 new for the lifecycle and GSTIN/PAN cross-check) |
| 7 | **Documentation** | This record |
| 8 | **Verification** | `pnpm verify` green; verified in-browser as a territory-scoped manager |

---

## 2. The controls, and how each was proven

### 2.1 Distributor is the second scoped entity

This is the test the Phase 3 record said would matter. Registering `distributor` in
`SCOPE_REGISTRY` and then checking that a WEST-scoped Sales Manager is **refused**:

| Attempt | Result |
|---|---|
| List distributors | **1 of 2** — only the Maharashtra partner, and the total count reflects it |
| Read the Tamil Nadu distributor by id | `404 NOT_FOUND` |
| **PATCH** the Tamil Nadu distributor | `404 NOT_FOUND` — writes are scoped, not just reads |
| Attach a note to it | `404 NOT_FOUND` |
| Target record afterwards | Unchanged, zero notes |

Writes matter as much as reads: without the write predicate, a caller who guessed an id could
mutate a record they cannot see.

### 2.2 KYC-gated approval

Approval is refused at every stage until the evidence exists, verified in sequence:

| Step | Result |
|---|---|
| Approve straight from `LEAD` | `409 INVALID_STATE_TRANSITION` |
| Approve from `PENDING_APPROVAL` with no verified KYC | `409` naming all three missing documents |
| Approve with KYC verified but no contact | `409` — nobody to reach about a dispatch |
| Approve with everything in place | `ACTIVE`, `onboardedAt` stamped |

Attaching KYC needs `distributor:document:manage`; **verifying** it needs
`distributor:approve`. Whoever uploads a GST certificate is not the person who attests it is
genuine.

### 2.3 Credit limit as a first-class control

Its own endpoint, its own permission (`distributor:credit:update`), a mandatory reason
(`422` without one), and always a SECURITY audit entry with before/after. The limit is what
stands between the company and unrecoverable exposure, so it is never changeable as a side
effect of editing a phone number.

### 2.4 Gapless code allocation

`NumberSequenceService` allocates inside the caller's transaction with `SELECT … FOR UPDATE`.
A Postgres `SEQUENCE` deliberately does not roll back on abort — that is what makes it fast —
so a failed transaction would burn a number permanently. Under GST, gaps in an invoice series
invite scrutiny, so this is built once here and exported for Phase 8's statutory series.

### 2.5 Statutory validation

GSTIN checksum, PAN format, IFSC, and Udyam all reuse the validators from
`primitives/india` — the same ones the Phase 1 checksum tests cover. Additionally, a GSTIN
embeds its holder's PAN at characters 3–12, so supplying both and having them disagree is
rejected: one of the two is a typo, and either way the resulting invoice would be wrong.

### 2.6 Money and secrets

Credit limits cross the wire as `"1500000.0000"` — a string, verified by inspecting the raw
response (ADR-0004). Bank account numbers are AES-256-GCM encrypted at rest and returned
masked.

---

## 3. One bug found

`NumberSequenceService` inferred whether to append a financial year from whether the key
contained a colon. That assumed the caller already knew the sequence's reset policy, and got
it silently wrong when they did not: `DISTRIBUTOR` (reset `NEVER`) was looked up as
`DISTRIBUTOR:2026-27`, which does not exist.

Now it tries the exact key first and falls back to the financial-year form, so `NEVER` and
`YEARLY` series both resolve without the caller knowing which they are using.

---

## 4. Audit trail

A full onboarding produces this, every entry attributed with actor, IP, and request id:

```
DATA      distributor.created
SECURITY  distributor.submitted_for_approval
DATA      distributor.kyc_attached          ×3
SECURITY  distributor.kyc_verified          ×3
DATA      distributor.contact_added
SECURITY  distributor.approved
SECURITY  distributor.credit_limit_changed
```

Lifecycle and KYC events are `SECURITY`, not `DATA` — each one changes whether this partner
can transact.

---

## 5. Deliberately deferred to Phase 4

Phase 5 sits after Phase 4 in the roadmap for two reasons, both now left as ready seams:

| Item | State |
|---|---|
| **Price list assignment** | `priceListId` exists as a plain nullable column with no FK. Phase 4 adds the constraint — a one-line migration, not a reshuffle |
| **Authorized product catalog** | `DistributorProduct` not created. It joins to `Product`, which does not exist yet |

Everything else about distributors is independent of the catalog and is complete.

**Also not built:** bulk CSV import (the API contract `importDistributorRowSchema` is defined
and tested; the endpoint is not), and create/edit forms in the UI — the list and 360 are
read-only, and every mutation is API-complete and verified by curl.

---

## 6. Where this leaves the roadmap

Phases 1, 2, 3, and 5 are done. **Phase 4 (Catalog & Pricing) is the gap**, and it is now the
critical path: products, BOM, price lists, and the date-effective GST engine are prerequisites
for orders (Phase 7) and invoicing (Phase 8), and they close the two seams above.
