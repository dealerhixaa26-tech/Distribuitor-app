# Phase 11 — create/edit forms, part 1: foundation and distributors

> Steps 0–2 of the forms plan. What was found before building, what was built, and what is
> deliberately still missing. Written after execution, not before.

---

## 1. What this covers

The UI was read-only. Every list and detail view worked; nothing could be created or edited, and
eight pages carried a "New …" button wired to nothing. The owner decided forms come before UAT, on
the reasoning that real users cannot test a system in which nothing can be created.

The agreed scope for this pass was three steps:

| Step | Delivered |
|---|---|
| **0** | Fix what verification found before building on top of it |
| **1** | A form kit — nine files, so thirteen later forms are assembly |
| **2** | Distributor create/edit, plus the state-transition actions |

Steps 3–6 (product · price list · quotation · order · invoice issue · payment verify) are **not**
in this pass. §7 says what they need.

Design reasoning is in **ADR-0025** (forms are routes, actions are dialogs) and **ADR-0026** (CSRF
enforcement triggers on the CSRF cookie).

---

## 2. Verification found six defects before a line of form code was written

Re-running the Phase 11 harnesses was supposed to be a formality. It was not. Two of these are
security-relevant and one had never worked at all.

### 2.1 🔴 The CSRF double-submit control was inert on every mutation the UI makes

`CsrfGuard` exempts callers that send no session cookie — a legitimate exemption for a
server-to-server client. It recognised one by looking for the **refresh** cookie, which the API
deliberately scopes to `/api/v1/auth` and the BFF rewrites to `/api/bff/auth`. The browser therefore
never sends it to `/api/bff/distributors`, so every mutation the admin UI makes was classed as a
cookie-free bearer call and skipped the check entirely.

Measured against the API directly, before the fix:

| Request | Status |
|---|---|
| refresh cookie + **forged** CSRF header | `401` — the guard works |
| refresh cookie + correct header | `201` |
| **no refresh cookie** + forged header | `201` — the guard never ran |

The third row is the shape of every request the UI makes. Through the BFF,
`POST /api/bff/reports/run` returned `201` with a forged token and `201` with no token at all.

Fixed by recognising a browser from the `csrf_token` cookie (`Path=/`, so it reaches every route)
rather than the path-scoped refresh cookie. `apiFetch` already sent the header — it had been sending
one nothing checked. Proven by **refusal**: `phase-11-forms-smoke.sh` asserts that a missing, forged
and unsigned header are each refused `401`, that the correct one is accepted, and that a cookie-free
bearer caller is still exempt. A check asserting only success would have passed against the broken
guard.

### 2.2 🔴 `reactivate` let a distributor reach ACTIVE without any verified KYC

Found because the new detail page offered both **Approve** and **Reactivate** on a
`PENDING_APPROVAL` record, which looked wrong. It was.

`approve()` checks verified KYC, a GSTIN, and at least one contact. `reactivate()` was guarded only
by `assertTransition(current, 'ACTIVE')` — and the transition table legitimately allows
`PENDING_APPROVAL → ACTIVE`, because that is what approval does. Reactivation silently inherited
that move.

Measured on the same record, one second apart:

```
POST /distributors/:id/approve      → 409  Cannot approve: GST_CERTIFICATE, PAN_CARD,
                                            AGREEMENT are not yet verified.
POST /distributors/:id/reactivate   → 200  status: ACTIVE
```

A partner could therefore transact, and be invoiced, with no verified KYC — skipping the GSTIN check
too, never recording `onboardedAt`, and never emitting `distributor.approved`.

This is **HANDOFF §4.21 met a second time**: an ACTION is not a status transition. `reactivate()`
now guards on `status === 'SUSPENDED'`, the only thing it means. Locked by
`status-action-guards.spec.ts`, which finds every pair of actions sharing a destination status and
asserts the narrower one carries its own precondition — a build-time check needing no database, in
the style of `invoice-immutability.spec.ts`. The UI carries the matching `from` constraint, because
the contract's table cannot distinguish two actions that end in the same place.

### 2.3 `phase-9-smoke.sh` check 20 had never executed

The reconciliation check ("receivables total == outstanding report total") reads `os.environ["API"]`
inside a python heredoc, but `API` and `T` were assigned, never `export`ed. It died with
`KeyError: 'API'` on every run since the Phase 9 commit — the two totals it exists to compare were
never compared. The assertion does hold (`297360.0000` both sides, checked by hand). One `export`
each. The suite is now **24/24** rather than 23 passing and one that could not run.

### 2.4 `GET /geography/cities?stateId=<non-uuid>` returned 500

The one query parameter in the API with no Zod schema behind it, on the endpoint an address form
calls every time someone picks a state. A malformed id reached Prisma and surfaced as
`INTERNAL_ERROR`. Now `listCitiesQuerySchema` in `@hixaa/contracts`, so it is a `422`. A 500 should
mean something here is broken; that distinction is what the ops alerting reads.

### 2.5 `Button asChild` was broken, and nothing had ever used it

Wrapping a `<Link>` in `<Button asChild>` threw *"Slot failed to slot onto its children"* — the
loading spinner means Radix's `Slot` receives two children. Fixed with `Slottable`. It had been
broken for as long as the loading state has existed; no caller had exercised it until the "New
distributor" button.

### 2.6 ⚠️ Idempotency is documented, modelled, and entirely unimplemented — still open

`docs/03 §5` states idempotency is **required** on `POST /orders`, `/payments`, `/invoices` and
every `/approve`. The `idempotency_key` table exists, so do the `IDEMPOTENCY_*` error codes, the
nightly purge job in `maintenance.processor.ts`, the CORS allowance in `main.ts`, and `apiFetch`'s
own `idempotencyKey` option. **No interceptor reads the header.** Nothing writes to or reads from
the table; the header is accepted and ignored.

Not closed in this pass — it is backend work of its own size, and it blocks none of Steps 0–2. But
it lands squarely on Steps 4–6: a double-clicked submit, or a retry after the BFF's 30-second
timeout, would create a second order or a second payment. `useEntityMutation` therefore deliberately
does **not** send an `Idempotency-Key`: sending one would dress an absent control as a present one.
Double submission is currently prevented only by `isPending` disabling the button, which does not
survive a page reload or a timeout.

**Recommendation: close this before the order and payment forms are built.**

---

## 3. Two defects found by driving the form, which no typecheck would have caught

### 3.1 The form refused every empty optional field

`pruneEmpty` stripped empty strings before the request, but `zodResolver` validated the **raw** form
values first — and `''` fails `gstinSchema`, `ifscSchema`, `indianPhoneSchema` and every other
refined string. Submitting a perfectly valid distributor produced twelve errors at once: territory,
account manager, TAN, CIN, Udyam, all four bank fields, both contact phones.

The form typechecked, rendered correctly, and could not create anything.

Fixed with `contractResolver`, which prunes with the *same function* before parsing, so what the
browser validates is what the server will receive. `NaN` counts as empty too —
`register(…, { valueAsNumber: true })` yields `NaN` for a cleared number input, and `NaN` survives
every other check.

### 3.2 The state select silently lost its value on every edit form

`<select>` options come from `/geography/states`, which resolves **after** first render. An
uncontrolled `register`ed select mounts with no matching `<option>`, falls back to `''`, and never
picks the default up again. The billing state read empty on an edit form whose record plainly had
one — so saving would post an address with no `stateId`, the field that decides place of supply and
therefore the CGST+SGST versus IGST split.

Now driven by `Controller`. Verified by reloading the edit page: `Maharashtra (27)`.

---

## 4. What was built

### The kit — nine files, `apps/web/src/components/form/` and `lib/`

| File | Why it exists |
|---|---|
| `field.tsx` | Label, description, error and control with `aria-invalid`/`aria-describedby` wired together. Plus `FieldSet`, `FieldRow` |
| `select.tsx` | A **native** `<select>`. Keyboard-complete, announced correctly, opens as the platform picker on a phone, correct without JavaScript — none of which a rebuilt Radix listbox gets for free, and all of which 11.3 would have to audit |
| `entity-picker.tsx` | ARIA 1.2 combobox over a list endpoint, debounced 200 ms, server-filtered. Says out loud when more matches exist than it is showing |
| `money-input.tsx` | `MoneyInput`, `QuantityInput`, `DateInput`. `type="text"` with `inputMode="decimal"`, never `type="number"` — money is `DECIMAL(18,4)` crossing the wire as a string precisely so it never touches a float (ADR-0004) |
| `form-dialog.tsx` | Radix dialog, and `ConfirmDialog` whose `consequence` is mandatory — "Are you sure?" tells the user nothing they did not know |
| `submit-bar.tsx` | `FormError` (with `unattributed`), `SubmitBar`, `useUnsavedChangesWarning` |
| `lib/form-errors.ts` | Places a server refusal on the field that caused it, or reports it in the summary. Never drops one |
| `lib/form-errors.spec.ts` | 10 tests, read back through RHF's own `get` |
| `lib/use-entity-mutation.ts` | `contractResolver`, `pruneEmpty`, and the mutation hook |

### Distributor — three routes and the actions

- `/distributors/new` and `/distributors/[id]/edit`, sharing one `DistributorForm` so the create and
  edit paths cannot come to validate different things. 35 fields, two nested addresses, banking,
  and the contract's own PAN↔GSTIN cross-check.
- `DistributorActions` on the detail page: Edit, Submit for approval, Approve, Suspend, Reactivate,
  Terminate, Change credit limit — availability driven by the contract's transition table plus an
  explicit `from` where an action means something narrower.
- The list page's dead "New distributor" button now navigates.

### One small backend addition

`GET /distributors/:id` gained an `editable` block: the fields the update DTO accepts but the
summary omits — TAN, CIN, Udyam, payment terms, website, three bank fields, and both addresses.
Without it an edit form shows blanks that read as "nothing on file".

Kept out of `DISTRIBUTOR_SELECT`, which also serves the list: two address joins on every row of a
table 11.2 load-tested at 100k, to render columns the list never shows.

**`bankAccountEncrypted` is deliberately absent.** An edit form does not need the account number to
leave it unchanged — `update()` treats `undefined` as not-supplied — so the plaintext is never
decrypted, sent, or held in a browser. The form shows the masked value and says blank means keep.

---

## 5. Proven by execution

Every claim below was run, not reasoned about.

**Create**, through the real UI, asserted in the database:

```
DIST-00003 | Vidarbha Control Systems Pvt Ltd | LEAD | gstin=27AACCV1234F1ZN | pan=AACCV1234F
  billing  -> Plot 14, MIDC Hingna, Nagpur 440016 [Maharashtra]
  shipping -> NULL — left blank, dropped whole rather than posted as {}
  total distributors: 3 → 4
```

**Edit**, including the banking claim:

| Step | `bank_account_encrypted` |
|---|---|
| after setting `50100123456789` | `V1:nLpKV1mgCyL+L…` |
| after a later edit with the field **blank** | `V1:nLpKV1mgCyL+L…` — byte-identical, trade name changed |

**Refusals**, which is what actually verifies a control (§4.4):

- `POST /reactivate` on `PENDING_APPROVAL` → `409`, record still `PENDING_APPROVAL`
- `POST /approve` without verified KYC → `409`, message naming the three missing documents,
  shown in the dialog, which stays open so the instruction does not vanish with a toast
- `POST /distributors` as `west.storekeeper` → `403`
- a forged CSRF header through the BFF → `401`

**The gate:**

| | |
|---|---|
| `pnpm verify` | ✅ lint · typecheck · tests · build |
| Tests | **453** — 247 API (+1 new suite), 196 contracts, 10 web (the first web tests in this repo) |
| `verify-worker-jobs` · `verify-monitoring` · `verify-scheduled-reports` · `verify-search-perf` | ✅ |
| `phase-8-smoke.sh` | ✅ 19/19 |
| `phase-9-smoke.sh` | ✅ **24/24** (was 23 + 1 that could not run) |
| `phase-11-forms-smoke.sh` | ✅ **26/26** — new |

---

## 6. Deliberately not done

- **Steps 3–6.** Product, price list, quotation, order, invoice issue, payment record/verify.
- **The periphery stays API-only**, and is recorded rather than quietly omitted: KYC upload,
  agreements, notes, contacts, BOM, specifications, media, discount rules, tax rates, shipments.
- **Idempotency** (§2.6) — the one item that should be closed before Steps 4–6.
- **In-app navigation guard.** `useUnsavedChangesWarning` covers reload and tab close only.
  Intercepting the App Router needs either a route guard that fights the framework or a global click
  handler that traps clicks it does not understand; a half-working guard that misses the common case
  is worse than an honest one.
- **The 500-row cap on `/geography/cities`** is unchanged. It does not bite at 14 seeded cities, and
  the address form takes free-text `cityName` anyway. Related to the deep-offset gap `docs/06` T13
  names and nothing implements.

---

## 7. What Steps 3–6 need, in order

1. **Customer create must come before quotation and order.** A `SECONDARY` order is refused without
   a `customerId` (`createOrderSchema.superRefine`), and the customers page has only a dead button.
   Small, but blocking.
2. **Quotation and payment have no detail page.** "Send a quotation" and "verify a payment" are
   detail-page actions, so those pages are part of the forms work, not separate from it.
3. **The line editor is the largest remaining component.** Product picker, quantity, optional
   override with a mandatory reason — and **never a price** (ADR-0011, §4.16). `POST /pricing/quote`
   returns a full per-line preview with the CGST/SGST/IGST split, `requiresApproval`, and a `trace`
   explaining why, so the total can be shown authoritatively while the client never holds a price.
   `phase-11-forms-smoke.sh` asserts a client-posted price is ignored.
4. **Close idempotency first** (§2.6).

### ⚠️ Before UAT reaches the invoice-issue form — an owner decision, not code

`company.statutory` is `{gstin: "27AAECH1234F1ZZ", pan: "AAECH1234F", verified: true}`. Those are
placeholders, and the documented refusal switch is **already set to true**. Three statutory numbers
have been burned against that fake GSTIN (`HTPL/INV/2026-27/00001…00003`).

A gapless GST series cannot be renumbered (§4.19, E2). Once issuing is one click away, every UAT
tester burns real numbers against a fake GSTIN. Building the form is fine. Letting UAT reach it
needs either E1 answered or `verified` set back to `false` and the sequence reset first.

### A note on the seed

`DIST-00003` was created through the form during verification and left in place. It is now the only
`PENDING_APPROVAL` partner with unverified KYC — the state UAT will spend most of its time in, and
what `phase-11-forms-smoke.sh` §"an action is not a status transition" asserts against. It is a
hand-made row, not a seeded one, so `pnpm db:reset` loses it and that smoke check fails loudly
rather than silently passing. Promoting it to `prisma/seed/` is the follow-up.
