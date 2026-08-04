# ADR-0004 — Money as DECIMAL with a value object; strings on the wire

- **Status:** Proposed (awaiting approval)
- **Date:** 2026-08-03

## Context

The system issues GST tax invoices — legal documents. Amounts must be exact, reproducible, and
auditable years later. Order totals, line discounts, tax splits, payment allocations, and ledger
balances must all agree to the paisa.

## Decision

1. **Database:** `DECIMAL(18,4)` for every monetary column. Never `float`, `double`, or
   `DOUBLE PRECISION`. Four decimal places because per-unit prices and tax intermediates need more
   precision than the two places a final amount is presented with.
2. **Application:** a `Money` value object wrapping `decimal.js`, exposing `add`, `subtract`,
   `multiply`, `allocate`, `round`, and comparisons. Arithmetic with `+` on a money value is caught
   by types.
3. **Wire format:** money is serialised as a **string** — `"152400.0000"` — never as a JSON number.
4. **Rounding:** half-up to 2 decimals per invoice line. The invoice's `round_off` column absorbs
   the residual so the grand total is a whole rupee, as is conventional on Indian invoices.
5. **Tax rates** live in a date-effective `tax_rate` table, not in code. Historical invoices retain
   their historical rate permanently.

## Consequences

**Positive**

- No floating-point drift. `0.1 + 0.2` is exactly `0.3`.
- JSON numbers are IEEE-754 doubles: any amount above 2^53 minor units, or any value with an
  inexact binary representation, is silently altered by `JSON.parse`. Strings eliminate this
  entirely — the value that leaves the database is the value the browser displays.
- Line taxes always sum to the invoice tax, verified by property-based tests over thousands of
  generated invoices.
- A GST rate change is an `INSERT`, not a deploy, and does not corrupt history.

**Negative**

- More verbose: `total.add(line.taxable)` rather than `total + line.taxable`.
- The frontend must parse strings before formatting. Handled once in a `formatMoney()` helper and a
  `<Money>` component.
- `DECIMAL` arithmetic is marginally slower than float. Irrelevant at this scale, and correctness is
  not a performance trade we would make.

**Rejected: integer minor units (paise) in `BIGINT`.** Exact and fast, and a perfectly respectable
choice — but per-unit prices in industrial quotations routinely carry more than two decimal places,
and every read/write would need scaling. `DECIMAL(18,4)` gives the same exactness without the
mental overhead.

**Rejected: `float` with rounding at the presentation layer.** This is the default mistake. It
appears to work in testing and produces an invoice that disagrees with its payment by a rupee
eighteen months later, in front of an auditor.
