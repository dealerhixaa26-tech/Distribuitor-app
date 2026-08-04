# 21 — Phase 7 Design: Sales

> Gate 1 (Design) for Phase 7. Written before any application code.
> New ADRs: **0011** (lines snapshot their pricing), **0012** (partial reservation and backorder),
> **0013** (pdfmake, not headless Chrome), **0014** (channel inventory derived, not self-reported).
> Completion record: `22-phase-7-completion.md`.

---

## 1. What this phase actually is

Phases 4 and 6 built two engines. Phase 7 is where they meet.

```
        PricingService.quote()          StockLedgerService.move()
        (ADR-0007, Phase 4)             ReservationsService (ADR-0002, Phase 6)
                    ↓                              ↓
   RFQ → Quotation → Order → [approve: price frozen, stock reserved] → Shipment → Invoice
                                                                                    (Phase 8)
```

**Nothing here reimplements pricing or stock.** Both services are exported for exactly this, and
the temptation to "just read `PriceListItem.price`" or "just decrement the balance" is the failure
mode both ADRs were written to prevent. Where Phase 7 needs a number it calls the engine; where it
needs to move stock it calls the ledger.

The two invariants this phase owns, from `docs/00-domain-and-scope.md` §4.2:

> 1. A distributor cannot exceed `creditLimit` unless a Finance Manager overrides, and the override
>    is audited.
> 2. Stock cannot be dispatched that is not on hand and reserved.

Everything else in Phase 7 is workflow around those two.

## 2. Three decisions taken with the owner

| Question | Answer | Recorded in |
|---|---|---|
| Stock not on hand at approval | **Reserve what exists, backorder the rest.** Approval succeeds; dispatch blocks per line | ADR-0012 |
| Exceeding an approval ceiling | **Any user whose ceiling covers it may approve.** Self-approval refused | §5 below |
| Quotation PDF | **Build a shared renderer now**, reused by Phase 8 invoices | ADR-0013 |

The first is the one that shapes the phase. Hixaa's lead times run 45–120 days because it builds to
order; a hard stock block at approval would make its principal product unorderable.

## 3. Schema — migration 0008

| Model | Notes |
|---|---|
| **`Customer`** + **`CustomerContact`** | End customers: plants, mines, government bodies. `Industry` already exists as real rows (Phase 3). Territory-scoped |
| **`Quotation`** + **`QuotationLine`** | Versioned by revision. Lines carry snapshotted pricing (ADR-0011) |
| **`Order`** + **`OrderLine`** | `PRIMARY` / `SECONDARY`. Lines carry the same snapshot, plus `quantityReserved`, `quantityBackordered`, `quantityDispatched` |
| **`OrderApproval`** | Who approved what, against which ceiling, with the reason. Append-only |
| **`Shipment`** + **`ShipmentLine`** | Carrier, LR number, vehicle, POD. Dispatch consumes reservations and issues stock |
| **`OrderTimeline`** | Append-only event feed per order — the "what happened to this order" screen |

**Seam closed:** `StockReservation.orderId` has been a plain column since Phase 6, waiting for
`Order`. It becomes a real FK here. That is the last open seam in the schema.

### Constraints the database enforces itself

- `CHECK (quantity > 0)` on every order and quotation line
- `CHECK (quantity_reserved + quantity_backordered <= quantity)` — the promise cannot exceed the order
- `CHECK (quantity_dispatched <= quantity_reserved + quantity_dispatched)` guarded in service; the
  DB enforces `quantity_dispatched <= quantity`
- Append-only trigger on `order_timeline` and `order_approval`, like `audit_log` and
  `stock_ledger_entry` before them
- Partial unique index: one `ACTIVE` quotation revision per quotation group
- Gapless `SO-…` / `QT-…` / `DC-…` numbers via the existing `NumberSequenceService`

## 4. The order lifecycle

`ORDER_TRANSITIONS` was declared as data in Phase 0 and is used as-is:

```
DRAFT → PENDING_APPROVAL → APPROVED → PROCESSING → PARTIALLY_DISPATCHED → DISPATCHED
                                                                            → DELIVERED → COMPLETED
        ↘ REJECTED → DRAFT              ↘ CANCELLED (until dispatched)
```

What happens at each gate that matters:

| Transition | Enforced |
|---|---|
| `DRAFT → PENDING_APPROVAL` | Distributor is `ACTIVE`; every product is in the authorized catalog; lines re-priced and the result shown |
| `PENDING_APPROVAL → APPROVED` | **Credit check** (§6). **Ceiling check** (§5). Self-approval refused. Then **reserve per line** (ADR-0012) |
| `APPROVED → CANCELLED` | All reservations released — stock must not stay held for a dead order |
| `→ PARTIALLY_DISPATCHED / DISPATCHED` | Driven by shipments, not set directly |

## 5. Approvals — ceiling-based, no self-approval

The role ceilings are already seeded and are the mechanism:

| Role | Level | Max discount | Max order value |
|---|---|---|---|
| Sales Executive | 40 | 0% | unlimited |
| Sales Manager | 60 | 10% | ₹25,00,000 |
| Finance Manager | 70 | 20% | unlimited |
| Admin / Super Admin | 90 / 100 | unlimited | unlimited |

An order needs approval when its effective discount exceeds the **submitter's** ceiling, or its
value exceeds it. The order is then approvable by any user whose own ceiling covers it.

Two refusals are absolute:

- **Self-approval.** The creator may never approve their own order, whatever their ceiling. Backed
  by the `preventSelfApproval` setting that `portfolio.seed.ts` already carries, and by the same
  reasoning as the existing `SelfApprovalError` and the KYC segregation in Phase 5 — whoever asks
  for a concession must not be the person who grants it.
- **Insufficient ceiling.** A Sales Manager cannot approve a 15% discount. The response names the
  ceiling and the figure, so the user knows to escalate rather than guessing.

Every approval writes an `OrderApproval` row recording the approver, the ceiling they held, the
figure approved, and the reason. Append-only.

## 6. Credit check — refuse, or override and be recorded

Exposure is computed as **approved-but-unbilled order value + outstanding invoices**. Phase 8 owns
invoices, so until then the second term is zero and the calculation is written to accept it
arriving without changing shape.

```
exposure + thisOrder > creditLimit  →  refuse with CreditLimitExceededError
```

A `FINANCE_MANAGER` (or above) may override with `POST /orders/:id/approve { creditOverrideReason }`.
The override is a **SECURITY** audit entry and raises an outbox event. `CreditLimitExceededError`
already exists from Phase 1 and names the limit and the exposure.

`creditLimit` of `0` means no credit — every order requires an override. That is the correct
reading of zero, and it is what a new `LEAD`-turned-`ACTIVE` distributor starts with.

## 7. Shipments — where the stock invariant bites

Creating a shipment picks lines and quantities. Dispatching it:

1. Refuses any quantity that is not **reserved** on that order line (ADR-0012 §3).
2. Calls `ReservationsService.consume()` — which releases the hold and posts the `ISSUE` movement
   in one transaction (Phase 6 built it that way precisely so Phase 7 cannot get it half-right).
3. Demands one serial per unit for serialized products (ADR-0009), recorded against the receiving
   distributor.
4. Advances the order to `PARTIALLY_DISPATCHED` or `DISPATCHED` by comparing dispatched totals
   against ordered totals — computed, never set by hand.

## 7a. Sell-out — the second ledger

The owner asked for **both** sell-in and sell-out, which is what `docs/00` §2.1 confirmed at the
outset. ADR-0014 records how channel stock becomes real; the shape it gives Phase 7 is:

```
PRIMARY  (sell-in)   Hixaa ──────────────► Distributor
                     dispatch posts TWO movements:
                       ISSUE   −qty  Hixaa's warehouse
                       RECEIPT +qty  the distributor's warehouse   ← channel inventory

SECONDARY (sell-out) Distributor ────────► Customer
                     dispatch posts ONE movement:
                       ISSUE   −qty  the distributor's warehouse
```

What remains in a distributor warehouse is, by construction, what that partner still holds. It is
**derived**, never self-reported.

Four rules follow, and three of them are obligations on later phases:

| Rule | Owner |
|---|---|
| A `DISTRIBUTOR` warehouse is provisioned on first dispatch to that partner, coded `WH-<code>` | Phase 7 |
| The channel receipt is valued at the order line's `unitPrice` — what the partner paid | Phase 7 |
| Company stock valuation **excludes** `DISTRIBUTOR` warehouses — those goods are already sold | Phase 9 |
| `SECONDARY` orders generate **no Hixaa invoice and no GST liability** | Phase 8 |

A `SECONDARY` order also skips the credit check entirely: the distributor already paid Hixaa for
these goods, so there is no exposure to check. Its prices are informational — the engine supplies a
default and the recorder overrides with what the partner actually charged.

## 8. API surface

```
GET/POST/PATCH  /customers · /customers/:id/contacts

GET    /quotations          · GET /quotations/:id · POST · PATCH
POST   /quotations/:id/price          re-run the engine, show what moved
POST   /quotations/:id/send           → SENT, emails the PDF via the outbox
GET    /quotations/:id/pdf            ⭐ synchronous download
POST   /quotations/:id/revise         new revision, supersedes the old
POST   /quotations/:id/accept | /reject
POST   /quotations/:id/convert        → a DRAFT order

GET    /orders · GET /orders/:id · POST · PATCH
POST   /orders/:id/submit             → PENDING_APPROVAL
POST   /orders/:id/approve            ⭐ credit + ceiling + reserve
POST   /orders/:id/reject | /cancel
POST   /orders/:id/reserve            re-attempt backordered lines
GET    /orders/:id/timeline

POST   /shipments · POST /shipments/:id/dispatch · POST /shipments/:id/deliver
```

## 9. Verification plan

The roadmap's exit is *"the complete order-to-dispatch flow works, with stock and credit correctly
enforced at every transition."* Nothing here is satisfied by a passing build.

1. **End to end**: customer → quotation → PDF → accept → convert → order → submit → approve →
   ship → deliver, checking the database at each step.
2. **Credit refused** at the limit; **Finance override accepted** and the audit row present.
3. **Self-approval refused** even for a Super Admin.
4. **Ceiling refused**: a Sales Manager cannot approve a 15% discount.
5. **Backorder**: approve an order for more than exists; assert partial reservation, and that
   dispatching the backordered quantity is refused.
5a. **Sell-out end to end**: dispatch a PRIMARY order, assert the distributor warehouse now holds
   the goods; raise a SECONDARY order against a customer, dispatch it, assert the distributor's
   stock falls and Hixaa's does not.
6. **Dispatch of unreserved stock refused** — invariant 2, tested directly.
7. **Cancelling an approved order releases its reservations**, verified against
   `stock_balance.quantity_reserved`.
8. **Scope denial** with `west.storekeeper` (scoped **and** holding write permissions —
   HANDOFF §4.14), on read and write.
9. **The ₹ glyph renders** in the PDF (ADR-0013 §5) — inspected, not assumed.
10. `pnpm verify` green.

## 10. Deferred, with reasons

| Deferred | Why |
|---|---|
| e-Invoice IRN / e-Way Bill API | Out of scope for v1 (`docs/00` §2.2). Adapter hooks land in Phase 8 |
| Quotation approval workflow | Quotations are proposals, not commitments; the approval gate belongs on the order |
| Automatic backorder allocation | ADR-0012 §4 — allocating scarce stock between customers is a commercial judgement, not a job |
| Order amendment after approval | An approved order is frozen (ADR-0011). Changes are a cancel-and-reraise until there is a documented amendment policy |
| Delivery scheduling / route planning | No fleet to plan. Carrier, LR and vehicle are recorded |
