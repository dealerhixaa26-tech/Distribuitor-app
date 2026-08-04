# ADR-0011 — Order and quotation lines snapshot their pricing

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

Phase 4 built one pricing engine (ADR-0007). `POST /pricing/quote` resolves a price list, a volume
slab, a discount rule, an optional manual override, and the GST split, and returns the result with
a full trace.

The question this ADR settles is what an order *stores* once that resolution has happened.

The tempting design is to store references — product id, quantity, price-list id — and re-resolve
the price whenever the order is displayed, invoiced, or reported on. It is appealing because there
is then exactly one number, never a stale copy.

It is also wrong, and the reason is that **every input to a price is mutable by design**:

- A price list is cloned and republished when prices change (Phase 4).
- A discount rule is deactivated when a promotion ends.
- A GST rate changes and a new date-effective `TaxRate` row is inserted (ADR-0008).
- A product's commercially significant fields change and cut a new revision.

An order re-priced against today's data is not the order the customer agreed to.

## Decision

**An order line stores the resolved commercial figures, not the inputs that produced them.**

At the moment a quotation line or order line is created, `PricingService.quote()` is called once
and the result is written onto the line:

| Stored | Why |
|---|---|
| `unitListPrice` | What the price list said, so a discount is explicable later |
| `unitPrice` | What was actually agreed, post-discount and post-override |
| `discountAmount`, `discountPercent` | The give-away, as a figure not a derivation |
| `taxableValue` | quantity × unitPrice |
| `hsnSacCode`, `gstRate` | The classification **in force that day** |
| `cgst`, `sgst`, `igst`, `cess`, `totalTax`, `lineTotal` | The tax split as computed then |
| `priceListId`, `discountRuleId`, `productRevision` | Provenance — which inputs produced this |
| `overrideReason` | Mandatory when overridden (ADR-0007 §4) |

Product name and SKU are snapshotted too. A product renamed after the fact must not silently
rewrite the description on a document a customer already holds.

**Re-pricing is explicit, never implicit.** Converting a quotation to an order re-runs the engine
and *shows the difference* if anything moved; it does not quietly adopt new numbers. A `DRAFT`
order can be re-priced on request. Once `APPROVED`, the figures are frozen.

## Consequences

**Positive**

- The order says what was agreed, permanently. That is the whole point.
- Phase 8 invoicing reads the order line and needs no re-resolution — which is what makes the
  invoice provably consistent with the order, rather than consistent-if-nothing-changed.
- Historical margin and tax reporting are answerable from stored figures, not reconstructions.
- A price list can be archived, a discount rule deleted, a product renamed, and every historical
  order remains intact and explicable.

**Negative**

- **Duplicated data.** The same price exists on the price list and on every line quoted from it.
  Accepted: this is the standard trade for temporal correctness, and it is the same reason
  `stock_ledger_entry` stores `unitCost` per row (ADR-0010 §3).
- **A price-list correction does not propagate.** If someone publishes a wrong price and ten
  quotations are raised against it, fixing the list does not fix the quotations. Mitigated by
  explicit re-pricing on `DRAFT` documents, and by `PRODUCT_PRICE_AFFECTING_CHANGE` already being
  emitted on the outbox (Phase 4) so a future job can flag affected drafts.
- Lines are wide — roughly fifteen commercial columns. Unavoidable if the figures are to be stored
  rather than derived.

**Rejected: store references and re-resolve on read.** Cheaper to write and catastrophic to
operate. Every historical document would silently change whenever a price list, discount rule, or
GST rate changed — including documents already sent to customers and, after Phase 8, invoices
already filed with the tax authority.

**Rejected: snapshot only the final amount.** Storing `lineTotal` alone loses the ability to answer
*why* — which discount applied, what the list price was, how the tax split was reached. That
question gets asked in exactly the situations where the answer matters most: a customer dispute and
a tax audit.
