# 22 — Phase 7 Completion: Sales

> Design: `21-phase-7-design.md`. ADRs: **0011** (lines snapshot their pricing), **0012** (partial
> reservation and backorder), **0013** (pdfmake, not headless Chrome), **0014** (channel inventory
> derived, not self-reported).
> Status: **complete and verified by execution.**

---

## 1. What was built

| # | Module | State |
|---|---|---|
| 7.1 | Quotations | ✅ Build, price, **PDF**, send, validity, revisions, accept/reject, convert |
| 7.2 | Orders (primary) | ✅ Full FSM, credit check, line snapshots, timeline |
| 7.3 | Approvals | ✅ Ceilings, self-approval refused, audited credit override |
| 7.4 | Shipments | ✅ Pack, dispatch, stock issue, carrier/LR/vehicle, POD |
| 7.5 | Orders (secondary) | ✅ Sell-out from the partner's channel warehouse |
| 7.6 | Customers | ✅ CRUD, contacts, industry, installed base |

### Numbers

| | After Phase 6 | After Phase 7 |
|---|---|---|
| Source lines | ~31,300 | ~38,400 |
| Tables | 60 | **70** |
| Migrations | 7 | **9** |
| Tests | 260 | **295** (142 contracts + 153 API) |

`pnpm verify` green: lint (5 pre-existing warnings, 0 errors), typecheck, tests, build.

**The last seam is closed.** `StockReservation.orderId` is now a real FK to `Order`. Every seam
deliberately left open across Phases 3–6 — `Distributor.priceListId`, `DistributorProduct`,
`Warehouse.distributorId`, `StockReservation.orderId` — is now shut.

---

## 2. Decisions taken with the owner

| Question | Answer | Recorded |
|---|---|---|
| Stock not on hand at approval | **Reserve what exists, backorder the rest** | ADR-0012 |
| Exceeding an approval ceiling | **Any user whose ceiling covers it.** Self-approval refused | §5 of docs/21 |
| Quotation PDF | **Shared renderer built now**, reused by Phase 8 | ADR-0013 |
| Sell-in and sell-out | **Both.** Channel stock derived from dispatches | ADR-0014 |

---

## 3. The flow, run end to end

Every figure below was read back from the database after the call.

```
Quotation QT/2026-27-00001   10 gateways   ₹8,40,000 + GST → ₹9,91,200
   ↓ send · accept · convert
Order SO/2026-27-00001       approved by a second user
   ↓ 6 in stock of 10 ordered
   6 reserved · 4 backordered · expected 2026-09-03 (30-day lead time)
   ↓ dispatch the 6
   WH-NGP        ISSUE   −6        ← Hixaa's stock leaves
   WH-DIST-00001 RECEIPT +6        ← channel inventory, warehouse auto-provisioned
   → PARTIALLY_DISPATCHED, 6 serials recorded
   ↓ partner sells 2 on
Order SO/2026-27-00002 (SECONDARY, no credit check — the partner already paid)
   WH-DIST-00001 ISSUE   −2

Final position: Hixaa 0 · partner 4 · plant 2 — derived, never self-reported.
```

---

## 4. Verification — by execution

### 4.1 The two invariants

| `docs/00` §4.2 | Proof |
|---|---|
| **1. Credit limit** | A ₹8.92L order against ₹5.09L headroom → **`CREDIT_LIMIT_EXCEEDED`**. With a Finance Manager's `creditOverrideReason` → approved, `creditOverridden=true` on the order, an `OrderApproval` row of kind `CREDIT_LIMIT`, and a **SECURITY** audit entry |
| **2. Dispatch only what is reserved** | Shipping 10 when 6 were reserved → *"only 6.00 is reserved and can ship. 4.00 is backordered, expected 2026-09-03"*. Enforced by drawing the reservation down, not by checking a number |

### 4.2 Controls that refused

| Attempt | Result |
|---|---|
| Convert a `DRAFT` quotation | ❌ *"Only an ACCEPTED quotation can become an order"* |
| Approve your own order (as Super Admin) | ❌ `SELF_APPROVAL_FORBIDDEN` |
| Order with no counterparty for its type | ❌ CHECK constraint |
| Credit override with no reason | ❌ CHECK constraint |
| Line promising 8+5 against a quantity of 10 | ❌ CHECK constraint |
| `UPDATE`/`DELETE` an approval row | ❌ append-only trigger |
| A customer GSTIN with a bad check digit | ❌ Phase 1 validator, on a number invented for this test |

### 4.3 Scope, tested with an account that HOLDS the permissions

`west.manager` is territory-scoped **and** holds `order:*`, `quotation:*`, `customer:*` — so a
refusal is unambiguously a scope refusal, per HANDOFF §4.14.

| Operation | Result |
|---|---|
| List quotations | Sees **1**; admin sees **2** |
| `GET` an out-of-scope quotation / customer | **404** each |
| Quote for an out-of-scope distributor | **404** |
| `PATCH` an out-of-scope customer | **404** |
| Send an out-of-scope quotation | **404** |
| The same operations in scope | **201** — not merely denying everything |

### 4.4 Cancel releases stock, and nothing drifts

Cancelling an approved order released its reservation (`reserved 9 → 0`, `available 11 → 20`,
reservation `RELEASED`), and the nightly reconciliation reported **clean** across every balance
after the whole sequence.

### 4.5 The PDF

Rendered, downloaded, and read back with `pdftotext`: **₹ intact**, Indian grouping
(`9,91,200.00`, not `991,200.00`), *"Rupees Nine Lakh Ninety One Thousand Two Hundred Only"*,
CGST/SGST shown separately, and the footer stating it is **not a tax invoice**. The unverified-GSTIN
warning fired correctly, because open question **E1** is still unanswered.

---

## 5. Five bugs — every one found by running it, none by typechecking

### 5.1 `FINANCE_MANAGER` could not approve orders at all

The role holds `distributor:credit:update` but **not** `order:approve`. Yet `docs/00` §4.2
invariant 1 says a Finance Manager forgives a credit breach — and that override is exercised
*through* `POST /orders/:id/approve`. **The invariant was unimplementable as seeded.**

Fixed in `permissions.seed.ts` with the reasoning inline. The 20% discount ceiling still bounds what
they may approve, and self-approval is refused regardless of role.

### 5.2 My own Phase 6 constraint blocked every final shipment

`stock_reservation_quantity_positive` asserted `quantity > 0`. Correct in Phase 6, where a
reservation was consumed whole. Phase 7's partial draw-down reduces the held quantity to **zero** on
the last dispatch — so every order's final shipment returned **500**, with stock already issued
inside the same transaction.

Migration 0009 replaces it with something **stricter**: an `ACTIVE` reservation must still hold
something; a closed one may hold zero. Both directions re-verified.

### 5.3 pdfmake 0.3 has a completely different API from its README

The docs describe `new PdfPrinter(fonts)`. That class does not exist in 0.3. The real surface,
found by probing the package: `require('pdfmake')` returns a configured **instance**, fonts register
via `addFonts()`, and `createPdf(def).getBuffer()` is async. Two implementations written from the
documentation typechecked cleanly and threw at the first render.

### 5.4 `WarehousesService` was not exported from `InventoryModule`

A DI wiring gap invisible to the compiler. Caught at boot.

### 5.5 A security hole pdfmake itself warned about

pdfmake warns when no access policy is set. Worth heeding here: document definitions are built from
**database content**, and pdfmake resolves images by URL or local path. Without a policy, a crafted
product name or address could make the renderer fetch an arbitrary URL (SSRF) or read a file off the
VPS. Both are now refused outright, except the bundled font directory.

---

## 6. Deferred, with reasons

| Deferred | Why |
|---|---|
| Order amendment after approval | An approved order is frozen (ADR-0011). Changes are cancel-and-reraise until there is a documented amendment policy |
| Automatic backorder allocation | ADR-0012 §4 — allocating scarce stock between waiting customers is a commercial judgement, not a job |
| Quotation approval workflow | A quotation is a proposal; the approval gate belongs on the order |
| Two-step approval for large orders | Offered and not chosen. Ceiling-based routing is what the owner picked |
| e-Invoice IRN / e-Way Bill | Out of scope for v1 (`docs/00` §2.2); adapter hooks land in Phase 8 |
| Create/edit **forms** | Consistent with the project-wide gap — every mutation is API-complete and curl-verified, and no module has forms yet |
| Delivery scheduling / routing | No fleet to plan. Carrier, LR, vehicle and POD are recorded |

---

## 7. Obligations this phase places on later ones

These are conventions, not type-enforced, so they are written down rather than left to be inferred
from a surprising number:

- **Phase 8 must exclude `type = 'SECONDARY'` from invoicing and GSTR-1.** A sell-out is the
  distributor's sale to their customer — no Hixaa invoice, no Hixaa GST liability (ADR-0014 §6).
- **Phase 9's stock valuation must exclude `DISTRIBUTOR` warehouses.** Those goods are already sold;
  counting them would overstate assets (ADR-0014 §4).
- **Phase 8 must refuse to ISSUE an invoice against `taxRateSource: 'PRODUCT_SNAPSHOT'`** — carried
  forward from Phase 4 and still outstanding.
- **Phase 8 adds the outstanding-invoice term to credit exposure.** `OrderApprovalService.checkCredit`
  already names it as a variable holding zero, so the addition is one line rather than a reshape.
- **`PricingService.quote()` and `StockLedgerService.move()` remain the only ways** to decide a price
  or move stock. Phase 7 consumed both rather than reimplementing either; Phase 8 must do the same.
