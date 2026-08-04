# ADR-0009 — Serial numbers are captured at dispatch, not at receipt

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

Hixaa sells serial-tracked hardware: Raksha IoT gateways and worker tags. `Product.isSerialized`
has existed since Phase 4 and marks them.

The domain study states the requirement plainly:

> Serial-number traceability matters — an IoT safety device deployed in a confined space is a
> warranty and liability object. We must know which serial went to which distributor, to which end
> customer, in which plant.

That requirement fixes *what* must be answerable. It does not fix *when* the serial is recorded,
and there are two defensible answers:

- **At goods receipt.** Every unit is registered the moment it enters the warehouse. Stock counts
  can then be reconciled serial by serial, and a unit is identifiable for its whole life in stock.
- **At dispatch.** Stock is received and held as a quantity; individual serials are recorded when
  the goods ship to a distributor.

Receiving 500 worker tags under the first model means keying or scanning 500 serials before the
stock is usable. Hixaa is a ~20-person engineering firm without warehouse scanners.

Asked directly, the owner chose **capture at dispatch**.

## Decision

1. **Goods receipt records quantity only.** A receipt of 500 tags is one ledger row of `+500`.
2. **Dispatch requires serials for a serialized product**, one per unit, validated for uniqueness
   and for not already being `SOLD` or `SCRAPPED`. A dispatch of 50 tags will not complete without
   50 distinct serials.
3. A `SerialNumber` row is **created at dispatch** with status `SOLD`, its warranty window opened
   from the dispatch date and closed at `dispatchDate + Product.warrantyMonths`.
4. `SerialNumber.status` still models the full lifecycle (`IN_STOCK`, `RESERVED`, `SOLD`, `RMA`,
   `SCRAPPED`) so a returned unit can be re-received against its existing serial. The `IN_STOCK`
   state is therefore reachable — just not the normal entry point.
5. **Serial-level stock counting is out of scope.** Stock counts reconcile quantities.

## Consequences

**Positive**

- The liability question is fully answered: given a serial, we can name the distributor, the
  customer, the dispatch date, and the warranty expiry. That is what a field incident needs.
- Receiving stays fast and needs no scanner, which matches how Hixaa actually operates today.
- Warranty starts from the date the unit left Hixaa, which is closer to commercially correct than
  the date it arrived in the warehouse — the buyer's warranty should not be eroded by shelf time.
- Fewer rows: a serial exists once it means something, rather than for every unit ever received.

**Negative**

- **A serial in stock has no identity.** Between receipt and dispatch, units are fungible. If a
  specific unit is damaged on the shelf, it is scrapped as a quantity, not as a serial.
- **Stock counts cannot be reconciled serial by serial.** A discrepancy is a quantity discrepancy;
  it cannot be narrowed to "these three units are missing".
- **A manufacturing recall by serial range is harder for units still in stock.** Dispatched units
  are traceable; on-hand units would have to be inspected physically. Accepted knowingly: Hixaa
  manufactures in small batches and would know the affected receipt.
- Dispatch is slower, which is the correct place to put the cost — it happens once per unit and it
  is the moment the traceability obligation actually attaches.

**Reversible in one direction.** Moving *to* capture-at-receipt later is additive: serials would
start being created at receipt with status `IN_STOCK`, and dispatch would look up rather than
create. Historical rows stay valid. Moving the other way would lose data. So this choice does not
foreclose the stricter model — which is the main reason it is safe to take the lighter one now.

**Rejected: optional capture at receipt with mandatory top-up at dispatch.** Maximum flexibility,
and it means a serial can be in either of two states for reasons nobody records. The reconciliation
between "registered at receipt" and "registered at dispatch" is real, ongoing complexity bought for
a convenience nobody asked for.
