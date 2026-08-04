# ADR-0007 — One pricing pipeline, one endpoint, and a traced result

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

A price in this system is never simply "the price". Between a product and the number that lands on
an invoice line there are at least five inputs:

1. Which **price list** applies (the distributor's assignment, or the default).
2. Which **volume slab** the quantity falls into.
3. Which **discount rules** match — by product, category, distributor, price list, or globally.
4. Whether a human **overrode** the number for this particular deal.
5. What **GST** applies, which depends on the post-discount value, the HSN/SAC, and where the
   goods are going.

The owner's requirement, verbatim, was that products be added "such that its price can be changed
according to situation". Hixaa's motion is RFQ-first project sales: a 50-worker Raksha deployment
into a thermal power plant is negotiated, not looked up. Any design that treats the price list as
the final word is wrong for this business.

The failure mode this ADR exists to prevent is the ordinary one: pricing logic gets written once in
the quotation service, again — subtly differently — in the order service, and a third time in the
invoice service. Then a quote and its invoice disagree by ₹340 and nobody can say which is correct.

## Decision

### 1. One engine, one endpoint

All price resolution lives in `PricingService.quote()`, exposed as **`POST /pricing/quote`**. It is
a pure calculation: it reads, it never writes. Quotations (Phase 7), orders (Phase 7), and invoices
(Phase 8) all call it rather than reimplementing it. There is exactly one place where the question
"what does this cost?" is answered.

The endpoint is a `POST` despite being a read because the request is a structured document — a
basket of lines with quantities, a distributor, a date, a place of supply — not something that
belongs in a query string.

### 2. Resolution is an ordered pipeline, and every step is recorded

Per line:

```
resolve price list → select volume slab → apply ONE discount rule → apply manual override → tax
```

The response carries a `trace` for every line: which list was used and why, which slab matched,
which rules were considered, which one won, which lost and for what reason, and what an override
changed. A resolved price with no explanation is unauditable — when a distributor disputes an
invoice eighteen months from now, "the system said so" is not an answer.

### 3. Discounts do not stack — the highest-priority rule wins

Candidate rules are filtered (active, date-effective, `minQty`/`minAmount` satisfied), then sorted
by `priority`, then by specificity as a tie-break (`PRODUCT` > `CATEGORY` > `DISTRIBUTOR` >
`PRICE_LIST` > `GLOBAL`). **One rule applies.** The others are reported in the trace as considered
and rejected.

Stacking is rejected deliberately. Two 15% rules that happen to both match is how a 30% discount
reaches a customer that nobody approved, and the resulting margin loss is invisible until a
quarter-end review. Making rules mutually exclusive means a rule's effect is knowable by reading
that one rule.

### 4. A manual override is an input, not a bypass

`POST /pricing/quote` accepts a per-line `override: { unitPrice, reason }`. The override replaces
the resolved unit price, and:

- `reason` is **mandatory** — an unexplained price concession is indistinguishable from an error.
- The response reports `effectiveDiscountPercent` against the list price, so the give-away is a
  number an approver can see rather than a comparison they must do by hand.
- When that percentage exceeds the caller's `Role.maxDiscountPercent`, the line is flagged
  `requiresApproval`. The pricing engine **does not refuse** it — it is a calculator, and refusing
  here would mean a salesperson cannot even see what a deal would look like. Enforcement belongs to
  the order approval workflow in Phase 7, which is the thing that can actually block a commitment.

This is the mechanism that answers "price can be changed according to situation" without turning
the price list into decoration.

### 5. A missing price is an error, never zero

If no `PriceListItem` matches a product, the line fails with `NO_PRICE`. It does not fall back to
zero, and it does not fall back to a cost field. A silently zero-priced line on a tax invoice is a
legal document giving goods away, and it is the kind of bug that ships because the happy path was
the only one tested.

## Consequences

**Positive**

- A quote, the order it becomes, and the invoice that follows cannot disagree: identical inputs
  through identical code.
- Pricing changes are data changes — a new price list version, a new discount rule — not deploys.
- The trace makes disputes answerable and makes the engine testable: assertions can be made about
  *why* a price was reached, not merely that it matched a fixture.
- Phase 7 gets pricing for free. Its work is workflow and approval, not arithmetic.

**Negative**

- The response is considerably larger than a bare number. Mitigated with `?trace=false` for callers
  that only need the totals; the trace is computed regardless, because the cost is in assembling
  the candidate rules, which must happen anyway.
- Every consumer must call the engine rather than reading `PriceListItem.price` directly. This is a
  convention the code cannot enforce; it is called out here and in the module README so a future
  contributor does not "optimise" it away.

**Rejected: stacking discounts with a cap.** Cumulative rules with a maximum total discount is what
most ERPs do. It is more flexible and materially harder to reason about — the effect of adding one
rule depends on every other rule that might co-match. Given that Hixaa's real negotiation happens
through the override path anyway, the flexibility buys little and costs clarity.

**Rejected: resolving price at order-line write time and storing only the result.** Orders and
invoices *do* store the resolved figures — they must, since a price list can change afterwards — but
the resolution itself stays callable and re-runnable, so a quote can be re-priced when it is
converted rather than silently carrying a stale number.
