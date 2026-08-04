# ADR-0015 — The party ledger is the source of truth for what is owed

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

Phase 8 has to answer one question reliably, from several directions:

- *"What does this distributor owe us?"* — the credit check, on every order approval.
- *"Show me the statement."* — a partner disputing a claim.
- *"Which invoices are 90 days old?"* — the aging report.
- *"Reconcile this against the bank."* — month end.

There are three common ways to hold that answer, and two of them fail.

**A balance column on the party.** `distributor.outstanding_balance`, incremented and decremented.
Fast, and wrong within a quarter: any code path that forgets to update it, any transaction that
half-fails, any manual correction in psql, and the number silently diverges from the documents. Its
failure mode is the worst available — it stays plausible.

**Derive everything from documents at read time.** Sum the invoices, subtract the payments,
subtract the credit notes. Always consistent, but it has no place to record anything that is not a
document: an opening balance carried in from Tally, a write-off, a TDS credit, a manual adjustment
after an argument. Those exist, and pretending otherwise means they get expressed as fake invoices.

**An append-only ledger.** Every event that changes what a party owes is one immutable row with a
debit or a credit. The balance is the sum. This is what accounting has done for five centuries and
what ADR-0002 already chose for stock.

## Decision

**`LedgerEntry` is append-only and is the source of truth for a party's balance.**

```
LedgerEntry
  partyType   DISTRIBUTOR | CUSTOMER
  partyId
  entryType   OPENING_BALANCE | INVOICE | CREDIT_NOTE | DEBIT_NOTE
            | PAYMENT | TDS | WRITE_OFF | ADJUSTMENT
  debit       DECIMAL(18,4)
  credit      DECIMAL(18,4)
  refType, refId
  entryDate, narration
```

### 1. Append-only, enforced by trigger

`UPDATE` and `DELETE` on `ledger_entry` are rejected by a database trigger, exactly as
`stock_ledger_entry` has been since migration 0007. Not a service convention — a service convention
is a comment that the next author does not read.

A mistake is corrected by a **contra entry**: a new row on the opposite side, referencing the one it
reverses. The wrong entry stays visible, which is the point. A bounced cheque, a mis-keyed amount,
and a disputed adjustment all leave a trail rather than a hole.

### 2. Exactly one side per row

`CHECK ((debit = 0) <> (credit = 0))`. A row carrying both, or neither, has no meaning. Enforcing it
in SQL costs nothing and removes an entire class of "the statement doesn't balance" investigation.

### 3. Debit increases what the party owes

Stated once, asserted in a unit test. An invoice debits; a payment credits; a positive running
balance is a receivable.

A sign convention that lives only in people's heads inverts itself within a year, usually inside one
report while the others still use the old one. The test is the record.

### 4. No materialised balance table

ADR-0002 paired the stock ledger with `stock_balance`, and that was right: a stock figure is read on
every order line and needs `SELECT … FOR UPDATE` on a hot row.

A party balance is not that shape. It is read on a statement screen and in a credit check — tens of
rows behind an index on `(party_type, party_id)`. A balance table would need the same locking
discipline for a fraction of the benefit, and it would create a second place that can disagree with
the ledger about what a distributor owes.

**Per-invoice outstanding is materialised**, on `invoice.amount_outstanding`, because aging asks
"how old is each unpaid invoice" and the ledger cannot answer that without reconstructing every
allocation. It is maintained by a BEFORE trigger from `grand_total − amount_paid − amount_credited`,
so it cannot drift from its own inputs, and `CHECK (amount_paid + amount_credited <= grand_total)`
stops the inputs going somewhere impossible.

### 5. The ledger is written inside the transaction that causes it

Issuing an invoice writes its debit in the same transaction. Verifying a payment writes its credit
in the same transaction. There is no reconciliation job, because there is no window in which a
document exists and its ledger effect does not.

## Consequences

**Good.** The balance cannot silently diverge from the documents, because it is not stored. Every
figure on a statement traces to a row that says what caused it. Opening balances, TDS, write-offs
and adjustments have a natural home instead of being forced into the shape of a fake invoice.
Corrections are visible rather than destructive.

**Costs.** A balance is a `SUM` rather than a column read — acceptable at Hixaa's scale (tens of
distributors, hundreds of invoices a year), and revisitable by adding a balance table later without
changing the ledger. Contra entries mean the ledger grows monotonically and a heavily corrected
account reads as busier than it is; that is the honest picture.

**Revisit when** a single party's ledger passes roughly 100,000 rows, or a statement query shows up
in the slow log. Both are far beyond the current horizon, and the fix — a rolled-forward balance
snapshot per financial year — is additive.
