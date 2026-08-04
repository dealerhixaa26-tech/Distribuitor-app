# ADR-0014 — Channel inventory is derived from dispatches, not self-reported

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

`docs/00-domain-and-scope.md` §2.1 recorded a confirmed scope decision:

> **Channel depth:** Sell-in **and** sell-out → two order ledgers (`PRIMARY`, `SECONDARY`), a
> `Customer` domain, and **distributor stock derived rather than self-reported**.

Phase 7 is where that last clause has to become real. A `SECONDARY` order decrements a
distributor's stock — which means a distributor must *have* stock in the system, and something has
to put it there.

Two ways to know what a partner holds:

- **Self-reported.** The distributor tells you, periodically. Universally done, universally wrong:
  reports arrive late, are estimated, and quietly diverge from reality until an argument about a
  claim forces a reconciliation.
- **Derived.** Compute it: what Hixaa shipped them, minus what they have reported selling on.
  Always current, and every figure traces to a document.

The domain study already chose derived. This ADR records how.

## Decision

### 1. Every distributor that receives goods gets a `DISTRIBUTOR`-type warehouse

`WarehouseType.DISTRIBUTOR` and `Warehouse.distributorId` have existed since Phase 3, with the FK
and its CHECK constraint added in Phase 6. Phase 7 provisions one on demand — created the first
time a shipment is dispatched to that partner, coded `WH-<distributor code>`.

Created lazily rather than at distributor approval, so a warehouse exists only for a partner who
has actually received something. A hundred `LEAD`-stage distributors do not create a hundred empty
warehouses.

### 2. Dispatching a `PRIMARY` order moves stock, it does not destroy it

A sell-in dispatch posts **two** movements in the same transaction:

```
ISSUE       −qty   Hixaa's warehouse       (consumes the reservation)
RECEIPT     +qty   distributor's warehouse (channel inventory)
```

Both go through `StockLedgerService.move()` (ADR-0002) — there is still exactly one way to write
stock. The goods have not vanished; they have moved along the channel, and the ledger says so.

### 3. A `SECONDARY` order issues from the distributor's warehouse

Sell-out decrements the partner's stock, not Hixaa's. Same reservation and dispatch machinery,
different warehouse. What remains is, by construction, what the partner still holds.

### 4. Distributor stock is NOT a Hixaa asset

Once dispatched and invoiced, the goods belong to the distributor. **Any company inventory
valuation must exclude `DISTRIBUTOR`-type warehouses**, or Hixaa would be counting goods it has
already sold as its own stock — an overstatement of assets, and precisely the sort of thing an
auditor is looking for.

The `type` column already carries the distinction; the rule is that valuation and stock-on-hand
reporting filter on `type = 'COMPANY'`. Phase 9's valuation report inherits this obligation, and it
is written here so that it is a stated rule rather than something inferred later from a surprising
number.

### 5. The channel receipt is valued at what the partner paid

The `RECEIPT` into the distributor warehouse carries the order line's `unitPrice` — the price the
distributor actually paid, which is their cost basis, not Hixaa's average cost. Using Hixaa's cost
would understate channel value and make sell-through margin meaningless.

### 6. `SECONDARY` orders are not Hixaa tax documents

A sell-out is the distributor's sale to their customer. It generates **no Hixaa invoice and no
Hixaa GST liability**. Prices on a `SECONDARY` order are recorded for sell-through analytics, and
its lines are priced through the same engine only to provide a sensible default — the recorder is
expected to override with what the partner actually charged.

Phase 8 must therefore exclude `type = 'SECONDARY'` from invoicing and from GSTR-1 export. Stated
here for the same reason as §4.

## Consequences

**Positive**

- Channel inventory is always current and every figure traces to a shipment document.
- Sell-through is computable: dispatched to a partner, minus their reported sell-out, is what they
  are sitting on — without asking them.
- No new machinery. Distributor stock uses the same ledger, balances, reservations, and
  reconciliation as company stock, and the nightly drift job covers it for free.
- A distributor's stock becomes visible to the future Distributor Portal with no extra work — the
  warehouse is already scoped by `territoryId`, and the portal's scope is the distributor itself.

**Negative**

- **Derived stock is only as good as the sell-out reports.** If a partner does not report a sale,
  the system believes they still hold the goods. That is a visible, investigable gap rather than a
  silent one, and it is strictly better than trusting a periodic self-report — but it is not
  automatic truth.
- **Two movements per dispatch line** instead of one. Twice the ledger rows on the sell-in path;
  cheap, and it is what makes the channel position derivable at all.
- **A rule that must be honoured downstream.** §4 and §6 are obligations on Phase 8 and Phase 9,
  enforced by convention rather than by the type system. Both are called out in
  `22-phase-7-completion.md` §7 so the next phase inherits them explicitly.

**Rejected: self-reported channel stock.** A `distributorStock` table the partner updates. Less
work, and it makes every downstream number an estimate whose accuracy nobody can establish. The
domain study rejected this before implementation began, and nothing here changes that.

**Rejected: no channel inventory at all — treat dispatch as the end of the story.** Simplest, and it
makes sell-out impossible to model, since a `SECONDARY` order would decrement stock that does not
exist. It would also make the confirmed sell-in-and-sell-out scope decision unimplementable.
