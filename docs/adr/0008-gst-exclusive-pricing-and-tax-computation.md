# ADR-0008 — GST-exclusive price basis and how tax is computed

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

Every price stored in a price list needs a declared basis: does `125000.0000` mean ₹1,25,000 before
GST, or ₹1,25,000 including it? The two produce different invoices from the same data, and the
difference is not recoverable after the fact — a column of numbers carries no memory of which
convention created it.

Indian practice genuinely uses both. FMCG and retail channels quote MRP, which is inclusive by law.
B2B project and capital-equipment sales quote ex-works, with GST added on top and shown as a
separate line, because the buyer reclaims it as input tax credit and needs to see it broken out.

Asked directly, the owner chose **GST-exclusive**.

This matters beyond convention. GST also splits two ways depending on geography: an intra-state
supply is CGST + SGST at half the rate each, an inter-state supply is IGST at the full rate. The
determinant is the *place of supply* against Hixaa's own state (Maharashtra, code `27`), and it is
decided per invoice, not per product.

## Decision

### 1. All stored prices are GST-exclusive

`PriceListItem.price`, every discount, and every resolved unit price are **taxable values, before
tax**. Tax is derived on top and never backed out. `PriceList.priceBasis` is stored explicitly as
`EXCLUSIVE` rather than left implicit, so the day an inclusive list is genuinely needed the existing
rows say what they always meant instead of being silently reinterpreted.

Deriving tax forward is strictly better than backing it out: `taxable × rate` is exact at four
decimal places, whereas `inclusive × 100/(100+rate)` produces a repeating decimal for most rates
(18% gives 84.745762…%) and leaves a residual on every single line that must be absorbed somewhere.

### 2. Rates live in a date-effective table, never in code

`TaxRate` is keyed by HSN/SAC code with `effectiveFrom` / `effectiveTo`. A rate change is an
`INSERT`. Historical invoices resolve the rate that was in force on *their* document date and are
therefore permanently reproducible.

`Product.gstRate` exists as a denormalised snapshot for list display and nothing else. **`TaxRate`
is authoritative.** This is written on the column comment as well as here, because a denormalised
copy that someone starts trusting is exactly how a rate change fails to take effect.

### 3. The split is decided by place of supply

```
supplierStateCode == placeOfSupplyStateCode  →  CGST (rate/2) + SGST (rate/2)
otherwise                                     →  IGST (rate)
```

Hixaa's state comes from the `company.statutory` setting, not a constant, so a future second
registration is a data change. Place of supply defaults to the distributor's GSTIN state code —
characters 1–2, which `stateCodeFromGstin()` already extracts.

### 4. Rounding: half-up at two decimals per line, residual at the document

Each line's tax is computed at four decimal places and rounded half-up to two. Line amounts sum to
the document total, and the difference between that total and the nearest whole rupee goes to a
single `roundOff` field — the convention Indian invoices already use, and the reason the field
exists on the invoice model.

The invariant, which is asserted by a property-based test over generated invoices rather than by
inspection:

> `sum(line.cgst + line.sgst + line.igst) == invoice.totalTax` exactly, for every invoice.

Computing document tax as `sum(taxable) × rate` independently of the lines is the standard way this
breaks: it differs from the sum of rounded lines by a few paise, and GSTR-1 reconciliation then
fails against a return the portal computed line-wise.

### 5. Services and goods are taxed through the same path

A `SERVICE` product carries a SAC code, a `GOODS` product an HSN, and the calculator resolves either
through the same `TaxRate` lookup. Commissioning and an IoT gateway sit on one invoice and must
tax consistently — Hixaa sells them together on the same document routinely.

## Consequences

**Positive**

- No inclusive-price residual anywhere in the system.
- A GST rate change is a row, applied without a deploy and without corrupting history.
- Line-to-document tax agreement is a proven invariant, not a hope, which is what makes GSTR-1
  export in Phase 9 tractable.
- Quotations can show ex-GST and inc-GST totals from one calculation.

**Negative**

- If Hixaa ever sells through a retail channel at MRP, an inclusive basis has to be added. The
  `priceBasis` column makes that additive — a new enum member and one branch in the calculator —
  but the calculator's tests roughly double at that point. Accepted knowingly: it is speculative
  today, and building both now would double the test surface for a channel that does not exist.
- Anyone entering price-list data must know the number is ex-GST. Handled in the UI with an explicit
  "Prices exclude GST" label on every price entry surface, not by assuming institutional memory.

**Rejected: a `taxInclusive` boolean per price-list item.** Maximum flexibility, and it makes every
downstream consumer branch on a per-row flag. Basis is a property of a *list* — a catalogue quoted
one way throughout — not of individual rows, and per-row mixing is a data-entry error waiting to be
made rather than a feature.

**Rejected: storing the tax split on the product.** CGST/SGST versus IGST is not a property of a
product; it is a property of a transaction between two places. Putting it on the product would be
wrong the first time Hixaa ships to Gujarat.
