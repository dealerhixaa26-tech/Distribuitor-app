# ADR-0018 — Verifying a payment, not recording it, is the financial event

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

`SEGREGATION_OF_DUTIES` has held this rule since Phase 2, before anything could act on it:

```ts
{
  a: PERMISSIONS.PAYMENT_CREATE,
  b: PERMISSIONS.PAYMENT_VERIFY,
  reason: 'The person recording a receipt must not be the person who confirms it.',
}
```

Phase 8 has to decide what that separation actually *does*. Two permissions with no behavioural
difference between them are decoration.

The question is when a receipt becomes real. A payment arrives as a claim — a partner says they have
paid, an executive keys in a cheque number, a UPI reference is pasted from a WhatsApp message. It
becomes a fact when someone matches it against the bank statement.

Three designs:

1. **Recording is the event.** The ledger is credited on `POST /payments`. Verification is a flag
   someone sets later. Simple; the separation is theatre. One person can reduce a receivable to zero
   with an unverified claim, and the credit limit that reduction frees up is real money.
2. **Verification is the event.** Recording writes a memo with no financial effect. Verification
   posts to the ledger and unlocks allocation.
3. **Recording posts to a suspense account**, verification reclassifies. Correct double-entry, and
   it requires a chart of accounts this system does not have and does not need at this stage.

## Decision

**Recording is a memo. Verification is the financial event. Allocation requires a verified payment.**

### 1. Three acts, three permissions, three states

| Act | Permission | State after | Ledger effect |
|---|---|---|---|
| Record | `payment:create` | `RECORDED` | **none** |
| Verify | `payment:verify` | `VERIFIED` | `PAYMENT` credit, plus a `TDS` credit if any |
| Allocate | `payment:allocate` | unchanged | none — moves `invoice.amount_paid` |

A `RECORDED` payment appears in lists, is visible to whoever needs to chase it, and changes no
balance anywhere. That is the correct representation of "someone says money arrived".

### 2. The service refuses self-verification, in addition to the role rule

`SEGREGATION_OF_DUTIES` stops one *role* holding both permissions. It cannot stop one *person*
holding two roles — which is normal in a company of Hixaa's size, where the same person may be both
Accounts Executive and Finance Manager during a colleague's leave.

So `PaymentsService.verify()` refuses when `verifiedById === recordedById`, throwing
`SelfApprovalError` — the same control, and the same error class, that `OrderApprovalService` uses to
stop someone approving their own order. Two independent mechanisms, because the role rule alone has
a hole big enough to drive the entire control through.

### 3. Allocation requires `VERIFIED`

This is the consequence that will be felt day to day, so it is stated plainly: a cheque recorded on
the 1st and cleared on the 5th leaves its invoice outstanding until the 5th.

That is what actually happened. Allowing allocation at `RECORDED` would let an unconfirmed claim
reduce a real receivable — and because `OrderApprovalService.checkCredit` now sums
`invoice.amount_outstanding`, it would also inflate the distributor's available credit. An
unverified payment would buy a real order. That is precisely the exposure the segregation rule
exists to prevent, and it would arrive through the back door.

### 4. TDS is a separate ledger credit

A customer settling a ₹1,00,000 invoice with ₹98,000 after deducting ₹2,000 TDS has paid in full.
The ledger records two credits: ₹98,000 `PAYMENT` and ₹2,000 `TDS`.

One combined ₹1,00,000 credit would lose the distinction, and the distinction is money: the ₹2,000
is recoverable from the government against Form 26AS, the ₹98,000 is cash in the bank. They
reconcile against different statements.

`Payment.amount` is cash received; `Payment.tdsAmount` is deducted tax; allocatable value is their
sum.

### 5. `BOUNCED` contra-posts, it does not delete

A cheque that bounces after verification moves to `BOUNCED`, writes opposing ledger entries, and
reverses its allocations. The original entries stay (ADR-0015 §1). A bounced payment is a thing that
happened, and the partner's ledger should show it.

### 6. Over-allocation is refused three times

A Zod refinement on the DTO, a `SELECT … FOR UPDATE` on the payment row inside the allocation
transaction, and a `CHECK` constraint.

Only the lock is the control — two concurrent allocations against one payment is a real race, and
check-then-write loses it exactly as check-then-lock lost the oversell race that
`StockLedgerService.move()` was built to close (HANDOFF §4.15). The other two make the failure fast
and the invariant legible.

## Consequences

**Good.** The segregation rule declared in Phase 2 now has teeth. No unverified claim can reduce a
receivable or free up credit. TDS reconciles against the right statement. The audit trail
distinguishes "someone said" from "we confirmed", which is the distinction an auditor will ask about.

**Costs.** Two people are needed to settle an invoice. In a small finance team that is friction, and
during a single-person week it is a block — the honest answer is that the block is the control
working, and the escape hatch is a role assignment, which is itself audited. Outstanding figures run
higher than a naive system would show, because uncleared cheques are still outstanding; that is
correct and will need explaining once.

**Revisit if** bank-statement import arrives (Phase 10). Automated matching could verify a payment
without a second human, and a system-verified payment is a stronger fact than a human-verified one —
at which point the segregation applies to the *exception* queue rather than to every receipt.
