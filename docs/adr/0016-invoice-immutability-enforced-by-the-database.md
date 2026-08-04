# ADR-0016 — Invoice immutability is enforced by the database, not the service

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

Under the CGST Act an issued tax invoice cannot be altered. If it is wrong, it is corrected by a
credit or debit note under s.34, which is itself a document with its own number and its own place in
the return. The original stands, wrong, forever.

That is a hard rule and this system must hold it. The question is *where*.

The obvious answer is the service: `if (invoice.status !== 'DRAFT') throw new ImmutableRecordError()`
at the top of `update()`. It is one line, it is readable, and it is what most systems do.

It is also not a control. This codebase has already demonstrated why, twice:

- HANDOFF §4.1 — both Prisma extensions were **silent no-ops for two entire phases**. Scope
  filtering and soft delete both looked implemented, typechecked, and did nothing.
- HANDOFF §4.14 — the scope extension's update predicate was malformed for two phases, and every
  scoped write 500'd for a non-global caller. A green build coexisted with a broken security control.

A service check protects the one code path it sits on. It does not protect a second service written
next phase, a `prisma.db.invoice.updateMany` in a batch job, a data-fix script, or someone in psql
at 11pm. For a security control that is a real but bounded risk. For a legal document, "someone
edited it directly" is the failure that ends the argument in the assessor's favour.

Stock made the same call in ADR-0002 and it has held: `stock_ledger_entry` rejects `UPDATE` and
`DELETE` at the database, and no amount of new code has been able to corrupt the ledger.

## Decision

**Once an invoice leaves `DRAFT`, its financial identity is frozen by a database trigger.**

### 1. What is frozen

A `BEFORE UPDATE` trigger on `invoice` raises an exception when `OLD.status <> 'DRAFT'` and any of
these changed:

```
number · invoice_date · due_date · place_of_supply_state_code · supplier_state_code
distributor_id · customer_id · order_id · supply_type · is_reverse_charge
subtotal · total_discount · taxable_value
total_cgst · total_sgst · total_igst · total_cess · total_tax
round_off · grand_total
```

Twenty-one columns: everything a reader of the printed document would recognise as the document.

### 2. What stays writable, and why that is not a loophole

```
status · amount_paid · amount_credited · amount_outstanding
cancelled_at · cancelled_reason · cancelled_by_id
sent_at · irn · ack_number · ack_date · signed_qr_code · eway_bill_number
updated_at
```

None of these is *on* the invoice as a legal instrument. They describe what has happened to it
since: it was settled, it was cancelled, it was sent, the portal acknowledged it. An invoice whose
paid amount can never change is not an immutable invoice, it is an unusable one.

The distinction that matters: **the claim is frozen, the history of the claim is not.**

### 3. Lines too

`UPDATE` and `DELETE` on `invoice_line` are rejected outright when the parent invoice is not
`DRAFT`. There is no partial-write case for a line — a line is entirely part of the document.

### 4. The service check stays as well

`InvoicesService.update()` still refuses on status, and still throws `ImmutableRecordError` with a
message naming the credit-note path.

Not redundancy — different jobs. The service produces a good error for a person who tried something
reasonable. The trigger produces an ugly one for a code path nobody reviewed. Removing the service
check would make the API rude; removing the trigger would make the guarantee a convention.

### 5. `DELETE` is permitted on a DRAFT invoice only

A draft consumed no number and has no ledger effect, so removing it leaves nothing inconsistent.
Issuing is the irreversible act, which is exactly why `invoice:create` and `invoice:issue` are
already separate permissions with a `SEGREGATION_OF_DUTIES` rule between them.

## Consequences

**Good.** The immutability guarantee survives code that has not been written yet. A migration, a
batch job, or a psql session cannot quietly rewrite a document that has been sent to a customer and
filed in a return. The rule is stated in one place that every access path goes through.

**Costs.** Trigger logic is invisible to anyone reading only TypeScript, so a legitimate future
change — an added money column — must remember to update the trigger's column list, and forgetting
means the *new* column is unprotected rather than anything breaking loudly. Mitigated by a unit test
that asserts the trigger's column list against the Prisma model's money fields, so an unlisted money
column fails the build.

Trigger errors are also not `DomainError`s and surface as 500s rather than 409s. Accepted: reaching
the trigger means the service check was bypassed, and that genuinely is an internal error.

**Revisit** only if Postgres is ever not the database — at which point far more than this is in play.
