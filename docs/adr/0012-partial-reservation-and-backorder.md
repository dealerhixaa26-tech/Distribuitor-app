# ADR-0012 — Partial reservation and backordered lines

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

Phase 6 built reservations: stock committed to an approved order but not yet issued, tracked on
`stock_balance.quantity_reserved` and refused when insufficient stock is *available* (ADR-0002).

Phase 7 has to decide what happens when an order is approved and the stock is not there.

For a fast-moving distributor this is an edge case. For Hixaa it is the **normal case**. The seeded
catalog carries lead times of 45–120 days:

| Product | Lead time |
|---|---|
| Test Bench — Rail / Simulation | 120 days |
| Automated Test Equipment — Custom Bench | 90 days |
| Machine Vision Inspection Cell | 75 days |
| Raksha IoT — 50-Worker Deployment | 45 days |

These are built to order. Requiring stock on hand before an order may be approved would mean Hixaa
could not accept an order for the thing it principally sells.

Asked directly, the owner chose **reserve what exists, backorder the rest**.

## Decision

### 1. Approval reserves what it can, per line

On `APPROVED`, each line attempts a reservation for its full quantity. Whatever is available is
reserved; the shortfall is recorded on the line:

```
quantity            10   what the customer ordered
quantityReserved     4   held now, unavailable to any other order
quantityBackordered  6   owed, not yet in existence
```

Approval **succeeds**. A partially-reserved order is a normal, expected state, not a degraded one.

### 2. `expectedAvailableDate` comes from the product's lead time

`Product.leadTimeDays` already exists and is populated. A backordered line carries
`approvedAt + leadTimeDays`, so the order screen can answer "when can we ship?" without anyone
guessing. It is an estimate and is labelled as one.

### 3. Dispatch is blocked PER LINE, not per order

A shipment may only include quantities that are actually reserved. Attempting to ship a
backordered quantity is refused with a message naming the shortfall. Partial dispatch is therefore
first-class: ship the four, dispatch the six when they are built.

This is the point where the strictness lives. Approval is optimistic; **dispatch is not**, because
dispatch is where a promise becomes a physical movement and where invariant 2 of `docs/00` §4.2
applies — *stock cannot be dispatched that is not on hand and reserved*.

### 4. Backorders are filled by an explicit action, not a background sweep

When stock arrives, a goods receipt does **not** silently reserve it against the oldest backorder.
`POST /orders/:id/reserve` re-attempts reservation for the outstanding quantities, and a report
lists which orders are now fillable.

Automatic allocation sounds helpful and is not: it decides, invisibly, which of several waiting
customers gets scarce stock. That is a commercial judgement — a strategic account may outrank an
older order — and it should be made by a person who can be asked why.

## Consequences

**Positive**

- Hixaa can accept orders for goods that do not exist yet, which is its actual business.
- Overselling is still impossible: a reservation either succeeds against available stock or is
  recorded as a backorder, and dispatch checks reservations rather than trusting the order.
- The order carries an honest picture — what is held, what is owed, when it is expected.
- Partial dispatch falls out naturally, which the `PARTIALLY_DISPATCHED` order status already
  anticipated in `ORDER_TRANSITIONS`.

**Negative**

- **An approved order is not a guarantee of stock.** Sales must read the reserved figure, not
  assume approval means availability. Mitigated by surfacing backordered quantities prominently on
  the order screen rather than burying them in a line detail.
- **Reservations can be held for months** against long-lead orders, making stock unavailable to
  shorter-lead opportunities. The Phase 6 expiry sweep only releases reservations with an
  `expiresAt`; long-lead order reservations deliberately have none. Revisit if stock contention
  becomes real — it cannot with a single warehouse and made-to-order goods.
- **Backorder filling is manual.** A deliberate cost, for the allocation-fairness reason above.

**Rejected: hard block until fully stocked.** Safest against overselling and commercially
unusable here. It would force sales to either not record real orders — putting them in a
spreadsheet, which is what the system exists to replace — or to fabricate stock.

**Rejected: approve freely, reserve only at dispatch.** Simplest to build. Two approved orders
could then promise the same unit, and the conflict surfaces at dispatch, in front of a customer,
with no record of who committed first. Reserving at approval is what makes "approved" mean
something.

**Rejected: automatic FIFO backorder allocation on receipt.** Tempting, and it quietly makes a
commercial decision nobody reviewed. Revisit only with an explicit allocation policy the owner has
chosen.
