# 20 — Phase 6 Completion: Inventory

> Design: `19-phase-6-design.md`. ADRs: **0002** (ledger, not counters), **0009** (serials at
> dispatch), **0010** (moving weighted average).
> Status: **complete and verified by execution.**

---

## 1. What was built

| # | Module | State |
|---|---|---|
| 6.1 | Warehouses | ✅ CRUD, four types, single-default enforced, territory-scoped |
| 6.2 | Stock ledger & balances | ✅ Append-only ledger, derived balance, row locking, non-negative constraint |
| 6.3 | Receipts & adjustments | ✅ Goods receipt with weighted-average costing, adjustments with reason codes, bulk opening balances |
| 6.4 | Batches & serials | ✅ Serial lifecycle at dispatch, warranty windows, trace lookup |
| 6.5 | Transfers | ✅ Two-phase dispatch/receive, visible transit stock, short receipts recorded |
| 6.6 | Reservations | ✅ Reserve / release / consume / expire, hourly stale sweep |
| 6.7 | Low stock | ✅ Per-warehouse reorder levels, daily alert via outbox |
| 6.8 | Reconciliation | ✅ Nightly re-derivation, drift **reported not healed** |

### Numbers

| | After Phase 4 | After Phase 6 |
|---|---|---|
| Source lines | ~26,600 | ~31,300 |
| Tables | 50 | **60** |
| Migrations | 6 | **7** |
| Tests | 232 | **260** (107 contracts + 153 API) |

`pnpm verify` green: lint (5 pre-existing warnings, 0 errors), typecheck, tests, build.

**Seam closed:** `Warehouse.distributorId` had been a plain column since Phase 3, waiting for the
Distributor model. It is now a real FK, with a CHECK constraint that a `DISTRIBUTOR` warehouse
names its owner and no other type may.

---

## 2. The three decisions taken with the owner

| Question | Answer | What follows |
|---|---|---|
| **E3** — warehouses | **One: Nagpur** | `WH-NGP` seeded as the default. Transfers, transit stock and multi-warehouse balances still built — distributor warehouses need them and Phase 7 will create them — but no fictional company sites |
| Opening stock | **None — start empty** | Ledger begins at zero; every unit's provenance is recorded. `POST /inventory/opening-balances` exists for a future stock take and **refuses** once a product has movement history |
| Serial capture | **At dispatch** | Receipts record quantity; issuing a serialized product demands one serial per unit. ADR-0009 records the costs accepted — chiefly that a unit in stock has no identity |

---

## 3. The exit criterion, met

The roadmap requires: *"concurrent dispatch attempts on the last unit produce one success and one
clean 409 — verified by a concurrency test, not by inspection."*

Stock was reset to **exactly one unit** via direct SQL (so the setup itself cannot be what makes
the test pass), then simultaneous issue requests were fired and the outcome asserted:

| Racers | Rounds | Result |
|---|---|---|
| 2 | 10 | **10/10** — 1 success, 1 × `409`, final on-hand `0` |
| 8 | 5 | **5/5** — 1 success, 7 × `409`, final on-hand `0` |

On-hand never reached −1, and no request returned anything other than `201` or `409`.

The mechanism is `SELECT … FOR UPDATE` taken **before** the quantity is read
(`stock-ledger.service.ts`). Checking availability and *then* locking is the classic
time-of-check-to-time-of-use bug: it reads correctly, reviews correctly, and oversells under load.

---

## 4. Verification — by execution

### 4.1 Database guarantees refuse on their own

| Attempt | Result |
|---|---|
| `UPDATE` / `DELETE` on `stock_ledger_entry` | ❌ both — *"append-only: post a compensating ADJUSTMENT instead"* |
| `RECEIPT` with a negative quantity | ❌ `stock_ledger_sign_matches_type` |
| `ISSUE` with a positive quantity | ❌ same |
| Zero-quantity movement | ❌ `stock_ledger_quantity_non_zero` |
| `ADJUSTMENT` / `SCRAP` with no reason | ❌ `stock_ledger_adjustment_needs_reason` (with a reason: accepted) |
| Negative on-hand | ❌ `stock_balance_on_hand_non_negative` |
| Reserving more than held | ❌ `stock_balance_reserved_within_on_hand` |
| Writing `quantity_available` directly | Silently **overridden** to the derived value |
| Second balance row for one (warehouse, product) | ❌ partial unique index |

### 4.2 Business rules

- Weighted average: 10 @ ₹84,000 then 10 @ ₹90,000 → **₹87,000**, exactly (ADR-0010).
- The ledger records each receipt at what was paid and the issue at the prevailing average — so
  COGS is historical, not restated.
- Reserving 15 of 20 dropped `available` to 5 and left `onHand` at 20; over-reserving and issuing
  into reserved stock were both refused with actionable messages.
- Serial rules: 3 units with 2 serials → refused; with 0 serials → refused; with 3 → accepted; a
  re-used serial → refused; a duplicate within one request → refused.
- Trace lookup answers the liability question: serial → distributor, dispatch date, warranty
  window, and whether it is still covered. Case-insensitive, because someone is reading a label.
- Two-phase transfer moved 5 out, received 4, and **recorded the short receipt** (`sent 5,
  received 4`) rather than silently reconciling it. Receiving twice was refused.
- Reconciliation: clean at baseline; a balance corrupted directly in SQL was **reported**
  (`recorded 999 vs ledger 17`) and deliberately **not healed** — the drift is the evidence.

### 4.3 Scope and permission, tested independently

| Caller | Operation | Result |
|---|---|---|
| `west.manager` (territory) | Read balances / ledger | Only WH-NGP rows; the out-of-scope warehouse's stock invisible |
| `west.manager` | `GET` out-of-scope warehouse | **404** |
| `west.storekeeper` (territory + write perms) | Receipt / issue / adjust / reserve / reorder / transfer into an out-of-scope warehouse | **404** on every one |
| `west.storekeeper` | Same operations in scope | `200` / `201` — not merely denying everything |
| `support` (global, low permission) | Any inventory mutation | **403**, and the database confirms nothing was written |

The out-of-scope warehouse's stock was re-checked afterwards and was **untouched** (7 units, 1
ledger row — only the original admin receipt).

---

## 5. Three real bugs found, two of them pre-existing

### 5.1 The scope extension broke every scoped `update` — a Phase 5 bug

**The most serious finding of this phase, and it was not in Phase 6 code.**

`update` and `delete` take a Prisma `WhereUniqueInput`, which must expose at least one **unique
field at the top level**. The scope extension was composing its predicate as
`{ AND: [{ id }, predicate] }`, which leaves no top-level `id` — so Prisma rejected the call
outright and every scoped update returned **500**.

It survived two phases because **a `GLOBAL` caller short-circuits before the predicate is built**.
Every test that used an admin token passed. And the one territory-scoped account available
(`west.manager`) held read-only inventory permissions, so out-of-scope write attempts returned
`403` on permission grounds — masking the fault entirely.

The blast radius was not limited to Phase 6: `west.manager` holds `distributor:update`, so
**every distributor edit by a territory-scoped user had been failing with a 500 since Phase 5**.
Confirmed fixed by execution — in-scope `PATCH` now `200`, out-of-scope `404`, and the
out-of-scope record unchanged.

Fixed by composing `update`/`delete` as `{ ...uniqueWhere, AND: [predicate] }`. Covered by 11 new
regression tests in `scope.extension.spec.ts`, including one asserting the exact shape Prisma
requires.

**The process lesson**, now in `dev-users.seed.ts`: a denial test needs an account that is scoped
**and** holds the write permission. Otherwise permission denial masks whether scoping works, and
the two controls are independent (HANDOFF §4.4). `west.storekeeper@hixaa.test` exists for exactly
this, and all three denial-test accounts are now seeded rather than living in one developer's
database.

### 5.2 Transfers destroyed inventory value

ADR-0010 §6 states that stock moves between warehouses at the source's average cost, so value is
neither created nor destroyed. The implementation passed no cost on the `TRANSFER_IN`, so the
destination received the goods at **₹0** — ₹4,35,000 of gateways arriving valued at nothing.

Caught by reading the ledger output during verification, not by a test. Fixed by carrying the
source's average across both transfer phases; re-verified as `TRANSFER_IN 2 @ 87000.0000`.

### 5.3 Prisma's diff proposed destroying Phase 4's search indexes

Migration 0007's auto-generated diff wanted to `DROP` the `search_vector` generation expression
**and all three product search indexes**, because Prisma cannot model generated columns and does
not know about raw-SQL indexes. Partial indexes escape this (Prisma skips what it cannot model),
which is why migration 0002's survived and these would not have.

Deleting the offending lines would have worked once and recurred on every future migration. Fixed
at the root instead: both derived columns (`product.search_vector`,
`stock_balance.quantity_available`) are now **trigger-maintained** rather than generated —
behaviourally identical, and ordinary-looking to the ORM — and the raw indexes are declared in
`schema.prisma` with `type: Gin` and `ops: raw(...)`. `prisma migrate diff` now reports
*"This is an empty migration."* Recorded as HANDOFF §4.13.

---

## 6. Deferred, with reasons

| Deferred | Why |
|---|---|
| FIFO costing | ADR-0010. Weighted average suits lumpy, low-volume receipts; the ledger keeps FIFO possible, at the cost of a replay migration |
| Serial-level stock counts | Follows from ADR-0009 — a unit in stock has no identity until dispatch |
| Bin / rack locations | One warehouse with no racking to model. Additive later |
| Landed cost apportionment | No procurement module; nothing to apportion from |
| Automatic reorder → purchase order | Purchase-to-pay is out of scope for v1 (docs/00 §2.2). Alerts are built; acting on them is manual |
| Stock valuation report | Phase 9. The data (`averageCost × onHand`) is present from day one and already exposed as `stockValue` |
| Writing off transit losses | A short receipt records the discrepancy on the transfer line; converting it to a `SCRAP` movement is a deliberate manual adjustment, not an automatic one |
| Stock count UI | `StockCount` / `StockCountLine` tables and the variance-posting path exist; the counting screen is frontend work, consistent with the project-wide forms gap |

---

## 7. Notes for the next phase

- **`StockLedgerService.move()` is the only sanctioned way to write stock.** Phase 7 must reserve
  on order approval and consume on dispatch through it, never by touching the tables. A second
  write path is a second place for the row lock to be forgotten, and that failure is silent.
- `ReservationsService.consume()` already releases the hold **and** posts the `ISSUE` in one
  transaction — Phase 7 calls it, it does not reimplement it.
- `StockReservation.orderId` is a plain column awaiting the Order model, the same seam pattern used
  for `priceListId` and `distributorId` before it. Add the FK in Phase 7.
- `SCOPE_REGISTRY` now has nine live entries. `serialNumber` is scoped by **distributor**, not
  warehouse, because a dispatched serial has no warehouse — a warehouse predicate would hide
  exactly the rows the trace lookup exists to find.
- `costing.ts` and `gst-calculator.ts` and `discount-resolver.ts` are **pure modules**. Keep them
  that way; it is why the tax invariant and the costing edge cases can be tested exhaustively
  without a database.
