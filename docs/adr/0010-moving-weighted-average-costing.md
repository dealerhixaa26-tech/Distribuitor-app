# ADR-0010 — Moving weighted-average cost, held on the balance

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

Every stock issue needs a cost. Without one there is no cost of goods sold, no margin, and no
inventory valuation for the balance sheet — and the figure has to be reproducible years later, in
front of an auditor, from data the system actually kept.

ADR-0002 already established that `stock_ledger_entry` records `unit_cost` on every movement, and
noted that "costing (weighted average, and FIFO later) is derivable". It deliberately did not pick
the method. This ADR picks it.

The realistic options:

- **Moving weighted average** — one cost per (warehouse, product), recomputed on each receipt.
- **FIFO** — issues consume the oldest receipt layers first; requires tracking un-consumed layers.
- **Standard cost** — a fixed planned cost, with variances posted separately.

Hixaa's inventory is a small number of high-value items with infrequent, lumpy receipts: a batch of
gateways, a batch of tags. It is not fast-moving goods with daily price movement.

## Decision

1. **Moving weighted average per `(warehouse, product, variant)`**, stored as
   `StockBalance.averageCost` and recomputed **only on inbound movements**:

   ```
   newAverage = (onHand × currentAverage + receivedQty × receiptUnitCost)
                ÷ (onHand + receivedQty)
   ```

2. **Outbound movements consume at the current average** and never change it. Issuing stock does
   not alter the cost of what remains — that is the defining property of the method.

3. **Every ledger row stores the `unitCost` used at that moment.** The balance holds the current
   average for the *next* transaction; the ledger holds what each historical movement actually
   cost. A restated average can therefore never rewrite history, and COGS for a past period is read
   from the ledger, not recomputed from today's average.

4. **Cost is computed in `Money` at `DECIMAL(18,4)`** (ADR-0004), never a float. An average cost is
   a division, so it is exactly where binary floating point would start drifting.

5. **A receipt with no cost defaults to the current average**, not to zero. A zero-cost receipt
   would silently drag the average down and understate inventory — the kind of error that is
   invisible until a year-end valuation.

6. Transfers move stock **at the source warehouse's average cost**, so moving goods between
   locations does not create or destroy value.

## Consequences

**Positive**

- One number per product per warehouse. Simple to compute, simple to explain to an accountant, and
  cheap — no layer table, no consumption bookkeeping.
- Concurrency-safe with no extra machinery: the average lives on the `stock_balance` row that is
  already locked `FOR UPDATE` for the quantity update (ADR-0002), so the read-modify-write of the
  average is serialised by the same lock.
- Smooths lumpy purchase prices, which is the desirable behaviour when the same component arrives
  at different prices across a year.
- Historical accuracy is preserved by the per-row `unitCost`, independently of the running average.

**Negative**

- **Not FIFO**, which Indian accounting standards permit but some auditors prefer. Weighted average
  is explicitly allowed under AS-2 / Ind AS 2, so this is a preference question, not a compliance
  one.
- Moving to FIFO later means either accepting a discontinuity or replaying the ledger to build
  layers. The ledger makes the replay *possible* — every receipt's quantity and cost is there —
  but it is a real migration, not a config change. That is the main cost of this decision.
- A return-to-stock at the original selling cost can nudge the average. Handled by returning at the
  current average rather than at the sale price.

**Rejected: FIFO now.** More faithful to physical flow and better under sustained inflation, at the
cost of a layer table, layer-consumption logic on every issue, and a much larger surface for
concurrency bugs. That complexity is not repaid at Hixaa's volumes.

**Rejected: standard costing.** Appropriate for repetitive manufacturing with stable BOMs and a
planning function to maintain the standards. Hixaa builds project systems to order; there is no
one to own the standards, and unmaintained standard costs are worse than none.
