# 19 — Phase 6 Design: Inventory

> Gate 1 (Design) for Phase 6. Written before any application code.
> Governing ADR: **0002** (ledger, not counters — now Accepted).
> New ADRs: **0009** (serials captured at dispatch), **0010** (moving weighted-average cost).
> Completion record: `20-phase-6-completion.md`.

---

## 1. The one thing this phase must get right

Everything else here is CRUD. This is not:

> Two users dispatch the last unit at the same instant. **Exactly one succeeds.** The other gets a
> clean `409`, and stock is never negative.

A mutable `stock_quantity` column fails this silently — both read 10, both subtract 6, the column
says 4 when it should say −2, and there is no history to reconcile against. ADR-0002 chose a ledger
plus a derived balance precisely so that this is structurally impossible rather than carefully
avoided.

The roadmap's exit criterion says this must be *"verified by a concurrency test, not by
inspection"*. §7 is that test.

## 2. Three decisions taken with the owner before coding

| Question | Answer | Consequence |
|---|---|---|
| **E3** — how many warehouses, where | **One: Nagpur** | Seed one `COMPANY` warehouse. Transfers, transit stock, and multi-warehouse balances are still built — distributor warehouses need them and Phase 7 will create them — but the company side stays honest to reality |
| Opening stock to load | **None — start empty** | Ledger begins at zero. Stock arrives through real goods receipts, so every unit's provenance is recorded. The `OPENING` movement type and a bulk opening-balance endpoint are still built, so figures can be loaded later without a migration |
| When serials are captured | **At dispatch** | Receipts record quantity; dispatch of a serialized product demands one serial per unit. Full reasoning and the accepted costs in ADR-0009 |

## 3. The transaction protocol — the heart of the phase

Every stock movement, without exception, runs this sequence inside **one** transaction:

```
BEGIN
  1. SELECT ... FROM stock_balance
       WHERE (warehouse, product, variant, batch)
       FOR UPDATE                      ← serialises concurrent movers here
     (INSERT a zero row first if none exists)

  2. Compute the new on-hand / reserved figures.
     REFUSE with 409 if the result would be negative.

  3. INSERT stock_ledger_entry          ← append-only, signed, immutable

  4. UPDATE stock_balance               ← derived read-model
     (recompute averageCost on inbound only — ADR-0010)
COMMIT
```

Four properties follow, and each is load-bearing:

- **The lock is taken before the check.** Checking availability and then locking is the classic
  time-of-check-to-time-of-use bug; it looks correct in review and fails under load.
- **Ledger and balance commit together.** A balance that can disagree with its ledger is worse than
  no balance, because it is trusted.
- **`CHECK (quantity_on_hand >= 0)`** is the last line of defence. Application logic refuses first;
  the constraint means even a bypass cannot produce negative stock.
- **A missing balance row is created, not assumed.** First movement for a (warehouse, product) is
  the common case at launch, since the ledger starts empty.

`StockLedgerService.move()` is the **only** method that writes either table. Receipts, issues,
adjustments, transfers, and reservation consumption all call it. Same argument as ADR-0007 for
pricing: one implementation, so the paths cannot diverge.

## 4. Schema — migration 0007

Nine models. `@db.Timestamptz(3)` throughout (HANDOFF §4.8).

| Model | Notes |
|---|---|
| **`StockLedgerEntry`** | Append-only, enforced by a database trigger like `audit_log`'s. Signed `quantity`, `unitCost`, movement type, `refType`/`refId`, actor. **No `deletedAt`** — it is never deleted, so the soft-delete extension leaves it alone by construction |
| **`StockBalance`** | Derived. `quantityOnHand`, `quantityReserved`, `quantityAvailable` as a **generated column** (`onHand − reserved`), `averageCost`. Unique on (warehouse, product, variant, batch) |
| **`Batch`** | Lot number, manufacture and expiry dates |
| **`SerialNumber`** | Created at dispatch (ADR-0009). Status lifecycle, warranty window, current distributor/customer |
| **`StockReservation`** | Order-linked, with `expiresAt`. Status `ACTIVE → RELEASED\|CONSUMED\|EXPIRED` |
| **`StockTransfer`** + **`StockTransferLine`** | Two-phase; stock sits in a `TRANSIT` warehouse between dispatch and receipt so it is visible rather than missing |
| **`InventorySetting`** | Per (product, warehouse) reorder level, reorder quantity, max level |
| **`StockCount`** + **`StockCountLine`** | Cycle counts; a variance posts an `ADJUSTMENT` through the same `move()` path |

**Seam closed:** `Warehouse.distributorId` has been a plain column since Phase 3, waiting for
Distributor to exist. It becomes a real FK here.

### Constraints the database enforces itself

- `CHECK (quantity_on_hand >= 0)` and `CHECK (quantity_reserved >= 0)` on `stock_balance`
- `CHECK (quantity_reserved <= quantity_on_hand)` — you cannot reserve what you do not have
- `CHECK (quantity <> 0)` on the ledger — a zero movement is a no-op recorded as if it were an event
- Append-only trigger on `stock_ledger_entry` (UPDATE and DELETE both raise)
- Partial unique index: one `ACTIVE` reservation per (order, product, warehouse)
- Partial unique index: one default warehouse

## 5. Reservations, and the invariant that keeps them honest

```
Order APPROVED   → reserve   (ACTIVE)    quantityReserved += qty
Order CANCELLED  → release   (RELEASED)  quantityReserved −= qty
Shipment created → consume   (CONSUMED)  quantityReserved −= qty, quantityOnHand −= qty
Stale            → expire    (EXPIRED)   quantityReserved −= qty
```

The invariant, checked by the nightly reconciliation job alongside the balance re-derivation:

> `stock_balance.quantity_reserved` == `SUM(quantity)` of `ACTIVE` reservations for that
> (warehouse, product, variant).

Reserved stock is **not** deducted from on-hand — it is physically still there. Only
`quantityAvailable` falls, which is why that column is generated rather than maintained: a derived
value that someone can write to will eventually be written to incorrectly.

Phase 7 owns the *triggers* for these transitions. Phase 6 provides the operations and enforces
their correctness.

## 6. API surface

```
GET    /warehouses                     · POST · PATCH · DELETE
POST   /warehouses/:id/set-default

GET    /inventory/balances             by warehouse, product, low-stock filter
GET    /inventory/balances/:productId  across all warehouses
GET    /inventory/ledger               the audit trail: why is stock 47?
POST   /inventory/receipts             goods receipt (+)
POST   /inventory/issues               issue (−), demands serials when serialized
POST   /inventory/adjustments          reason code mandatory, own permission
POST   /inventory/opening-balances     bulk OPENING entries

POST   /inventory/transfers            create (DRAFT)
POST   /inventory/transfers/:id/dispatch   source → TRANSIT
POST   /inventory/transfers/:id/receive    TRANSIT → destination

POST   /inventory/reservations         reserve
POST   /inventory/reservations/:id/release
POST   /inventory/reservations/:id/consume

GET    /inventory/serials              · GET /inventory/serials/:serial  ⭐ the trace lookup
GET    /inventory/low-stock            below reorder level
PUT    /inventory/settings             reorder levels per product+warehouse
POST   /inventory/reconcile            manual trigger; the job runs nightly
```

## 7. Verification plan

HANDOFF §4.4 and the roadmap's exit criterion. Nothing here is satisfied by a passing build.

1. **The concurrency test — the headline.** Seed exactly 1 unit. Fire two genuinely simultaneous
   issue requests. Assert **one 201 and one 409**, and that final on-hand is `0`, never `−1`.
   Run repeatedly, since a race that passes once proves nothing.
2. **The `CHECK` constraint refuses directly in psql**, bypassing the application entirely.
3. **The ledger is append-only**: `UPDATE` and `DELETE` on `stock_ledger_entry` must both raise.
4. **Scope denial**: `west.manager` must get `404` on stock in an out-of-scope warehouse, on read
   **and** write.
5. **Reservation invariant**: reserve, release, consume; assert `quantityReserved` matches the sum
   of `ACTIVE` reservations at each step, and that over-reserving is refused.
6. **Serial enforcement**: dispatching 3 serialized units without 3 serials must be refused;
   a duplicate serial must be refused; the trace lookup must name the distributor.
7. **Reconciliation detects real drift**: corrupt a balance directly in SQL, run the job, confirm
   it reports the drift rather than silently healing it.
8. `pnpm verify` green.

## 8. Deferred, with reasons

| Deferred | Why |
|---|---|
| FIFO costing | ADR-0010. Weighted average fits lumpy, low-volume receipts; the ledger keeps FIFO possible later |
| Serial-level stock counts | Follows from ADR-0009 — a serial in stock has no identity |
| Bin / rack locations within a warehouse | One warehouse with no racking system to model. Additive later |
| Landed cost (freight, duty apportionment) | No procurement module yet; there is nothing to apportion from |
| Automatic reorder → purchase order | Purchase-to-pay is explicitly out of scope for v1 (docs/00 §2.2). Low-stock alerts are built; acting on them is manual |
| Stock valuation report | Phase 9 reporting. The data (`averageCost` × `onHand`) is present from day one |
