# ADR-0002 — Ledger-based inventory instead of mutable stock counters

- **Status:** Proposed (awaiting approval)
- **Date:** 2026-08-03

## Context

Inventory must track stock across company and distributor warehouses, with reservations, transfers,
batches, and serial numbers — under concurrent dispatch by multiple users.

The naive design is a `stock_quantity` column on a product-warehouse row, updated with
`UPDATE … SET quantity = quantity - ?`.

## Decision

Two tables:

1. **`stock_ledger_entry`** — append-only and immutable. Every movement is a signed row
   (`+` in, `−` out) with its type, reference document, cost, and actor. **This is the source of
   truth.**
2. **`stock_balance`** — a derived read-model holding `quantity_on_hand`, `quantity_reserved`, and a
   generated `quantity_available`. Updated **in the same transaction** as the ledger, under
   `SELECT … FOR UPDATE` on the balance row.

Plus a `CHECK (quantity_on_hand >= 0)` constraint and a nightly job that re-derives every balance
from the ledger and alerts on drift.

## Consequences

**Positive**

- **Concurrency is correct.** Two simultaneous dispatches of the last unit serialise on the balance
  row lock; one succeeds, the other gets a clean `409`.
- **Complete history.** "Why is stock 47?" is answerable by reading the ledger, not by guessing.
- Adjustments are compensating entries, never edits, so the audit trail is unbroken.
- The `CHECK` constraint means the database itself refuses negative stock even if application logic
  is bypassed.
- Reconciliation detects a bug within hours instead of at the annual stock count.
- Costing (weighted average, and FIFO later) is derivable because every receipt's cost is recorded.

**Negative**

- Two writes per movement instead of one.
- The ledger grows quickly; it is monitored and partition-ready by year.
- Developers must understand that the balance is derived and must never be updated directly.

**Rejected: counter-only.** It corrupts silently under concurrency, and the corruption is
unrecoverable because no history exists to reconcile against. Every inventory system that has ever
shown a negative stock figure to a user made this choice.

**Rejected: ledger-only, computing balances with `SUM()` on read.** Correct, but a `SUM()` over
millions of ledger rows on every product page is not viable at the stated scale.
