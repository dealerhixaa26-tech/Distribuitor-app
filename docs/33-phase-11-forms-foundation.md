# Phase 11 — create/edit forms: foundation, distributors, and the catalogue

> Part 1 (§1–7): the form kit and distributors. Part 2 (§8–13): idempotency closed, then customer,
> product and price list. What was found before building, what was built, and what is deliberately
> still missing. Written after execution, not before.

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

Steps 3–6 (product · price list · quotation · order · invoice issue · payment verify) were **not**
in that first pass. §7 says what they need; part 2 then closed idempotency and delivered customer,
product and price list.

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

### 2.6 ✅ Idempotency was documented, modelled, and entirely unimplemented — now CLOSED

> Closed in part 2. The finding as originally written is kept below because it is the clearest
> statement of what was wrong; §8 describes the fix.


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

**Recommendation: close this before the order and payment forms are built.** — done, see §8.

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

---

# Part 2 — idempotency, and the catalogue forms

Continuing the same pass: close §2.6, then customer + product + price list.

## 8. Idempotency is now real

`docs/03 §5` had promised it since Phase 0 and nothing implemented it. What existed was the whole
apparatus around an absent control: the `idempotency_key` table, the `IDEMPOTENCY_KEY_REUSED` error,
the nightly purge in `maintenance.processor.ts`, the CORS allowance, and `apiFetch`'s own option.
The header was accepted and ignored.

**`IdempotencyInterceptor`** now implements the documented contract: key + endpoint + a hash of the
body are stored; a replay with the same key and body returns the **stored response** with
`Idempotency-Replayed: true`; the same key with a different body is a `409`; keys expire after 24
hours.

Four decisions worth recording:

**It is the OUTERMOST interceptor.** Interceptor responses unwind outermost-last, so registering it
ahead of `TransformInterceptor` is what lets it store the body the client actually received —
enveloped, with Decimals already rendered as strings. Storing the raw handler return would replay a
Decimal as a JSON number and the replay would disagree with the original by a rounding error: the
exact defect ADR-0004 exists to prevent, reachable only on the retry path.

**The insert is the lock.** The row is written before the handler runs, so the unique index on
`(key, userId, endpoint)` serialises concurrent attempts. A second request arriving while the first
is in flight finds a row with no response yet and is refused rather than allowed to run in parallel.

**A refused request does not burn the key.** The row is deleted when the handler throws, so a payment
rejected for a bad amount is retryable with the same key once fixed. Remembering the failure would
turn a typo into a dead key and push people toward a fresh key per attempt, defeating the mechanism.

**Keys are hashed order-insensitively.** A client whose JSON serialiser reorders object keys on the
retry is still recognised as the same request. Array order is preserved, because order is meaningful
in a document's lines.

### Which routes require it

Marked with `@Idempotent()` — explicit, never inferred from the path. Matching `/approve` as a string
would have missed `POST /payments/:id/verify`, which is the financial event (ADR-0018).

The eight `docs/03 §5` names: `POST /orders`, `/orders/from-quotation/:id`, `/orders/:id/approve`,
`/invoices`, `/invoices/from-order/:id`, `/invoices/from-shipment/:id`, `/payments`,
`/distributors/:id/approve`.

Seven more, **deliberately beyond the document** because they are the acts that actually consume a
statutory number or post to the ledger: `/invoices/:id/issue`, `/credit-notes` and its `/issue`,
`/debit-notes` and its `/issue`, `/payments/:id/verify`, `/payments/:id/allocate`. A duplicate here
is worse than a duplicate DRAFT, and a gapless GST series cannot be renumbered (§4.19).

`idempotency-coverage.spec.ts` reads the metadata back off the controllers — metadata, not source
text, so a `@Idempotent` in a comment would not satisfy it. A new money endpoint that forgets the
decorator fails the build.

### Proven by execution, on a real receipt

| Check | Result |
|---|---|
| money-moving POST with no key | `422`, naming the header |
| first attempt | creates `IDEM-SMOKE` |
| retry with the **same** key | returns the **same payment id** |
| rows in `payment` for that reference | **1** |
| replay response header | `Idempotency-Replayed: true` |
| same key, **different** body | `409` |
| fresh key | `201`, a second receipt |
| key first used by a **refused** request | `201` — still usable |

The third row is the assertion that matters. A replay that quietly created a second payment would
also have returned `201`; only comparing the ids catches it.

### What it broke, and why that was worth it

Requiring the header is a breaking change for every existing caller. Three consequences, all fixed:

- `phase-8-smoke.sh` — six POSTs now send a per-call key via an `idem()` helper.
- `phase-11-forms-smoke.sh` — the "empty body → 422" checks for `/orders` and `/payments` now send a
  key. Without one they would still have answered `422`, **for a missing header rather than an empty
  body**, and passed while testing nothing they claimed to.
- `useEntityMutation` sends a key on every mutation, generated **once per form** and held in state,
  not per click. That is the whole point: a retry after the BFF's thirty-second timeout must carry
  the same key. A fresh one is minted after each success.

## 9. Customer, product, and price list

| Form | Routes | Notes |
|---|---|---|
| **Customer** | `/customers/new`, `/customers/[id]/edit` | Unblocks `SECONDARY` orders |
| **Product** | `/products/new`, `/products/[id]/edit` | HSN/SAC field follows the selected type |
| **Price list** | `/price-lists/new`, `/price-lists/[id]`, `/price-lists/[id]/edit` | Detail page is new; publish/archive dialogs |
| **Price list slabs** | on the detail page | First repeating-row editor — the pattern the order/quotation line editors will follow |

**Reuse, not repetition.** The nine-field address block came out of `distributor-form.tsx` into
`components/form/address-fields.tsx` and is now shared by both forms that embed `addressSchema`.
Writing it twice would be two chances to diverge on `stateId`, which decides place of supply and
therefore whether an invoice carries CGST+SGST or IGST.

**The product form renders the contract's rule rather than restating it.** `superRefine` says a
SERVICE is classified by SAC, everything else by HSN, never both — so the form shows one field or the
other according to the selected type, and drops the unused code from the payload. Switching
GOODS → SERVICE after typing an HSN would otherwise submit both and be refused by a rule the user
cannot see.

**`replaceAll` is surfaced, not assumed.** Merging leaves untouched slabs alone; replacing deletes
everything absent from the submission, including rows someone else added since the page loaded. The
warning says so when the box is ticked. Guessing either way silently discards prices.

**ARCHIVED lists are read-only in the UI.** Editing one would rewrite what a past quotation was
priced against — and every document snapshots its own pricing anyway (ADR-0011), so there is nothing
to gain and a record to corrupt.

## 10. Three more defects, all found by driving the UI

### 10.1 🔴 `EntityPicker` was silently empty for every reference lookup

`apiFetch` returns the whole envelope only when `meta` is present (§4.10). Paginated endpoints yield
`{ data, meta }`; small reference lookups — `/territories`, `/categories`, `/geography/industries` —
yield the **bare array**. The picker read `.data` off both, so every reference picker showed
"No matches" against a `200 OK`, with nothing in the console to see.

**This was already shipped**: the territory picker on the distributor form had been broken since the
moment it was written, and the create form still worked because territory is optional.

Fixed by reading both shapes. The distinction also decides where filtering happens: a paginated
endpoint has already applied `?q=` server-side and may be hiding more rows; a bare array **is** the
whole list and the endpoint ignored `q`, so it is filtered in the browser. Measured after the fix:
18 territories listed, and typing `maha` narrows to one.

`phase-11-forms-smoke.sh` now pins which endpoints are which shape, so a list endpoint that gains or
loses pagination is noticed rather than quietly emptying a picker.

### 10.2 `GET /geography/uoms` did not exist

Ten units of measure have been seeded since Phase 3 with nothing able to read them, so
`Product.uomId` was settable only by direct API call — effectively unreachable from any interface.
Added beside `/geography/states` and `/industries`, carrying each unit's GST Unit Quantity Code,
which is what a GSTR-1 line must report.

### 10.3 The `editable` projection gap, for the third time

Distributor, then customer, then product: the detail response omits fields the update DTO accepts, so
an edit form pre-filled from it shows blanks that read as "nothing on file" and saves them over real
data. Each now returns an `editable` block.

`product.uomId` was the sharpest case — the summary carries only `uomCode`, so an edit form had no id
to send back and **every save would have unset the unit**. All three projections are now asserted in
the smoke suite by their exact field lists.

## 11. Proven end to end

The three forms were driven in a browser and the results read out of the database — then the chain
was checked against the pricing engine, which is the point of building them.

```
CUST-00003  Koradi Thermal Power Station · INDUSTRIAL · territory=Maharashtra
            billing  -> Koradi Power House Road, Koradi 441111 [Maharashtra]
            shipping -> NULL — blank dropped whole, not posted as {}

HTPL-RAKSHA-BEACON  Raksha Confined-Space Beacon · GOODS · DRAFT
                    hsn=85311020  sac=NULL  gst=18.00  serial=true  warranty=24  wt=450

PILOT-2026  Pilot Price List 2026-27 · DRAFT → ACTIVE (published through the dialog)
            slab minQty=1   price=18500  floor=15000
            slab minQty=10  price=16750  floor=14000
```

Then `POST /pricing/quote` against that list:

| Quantity | Unit | Slab matched | Tax | Line total |
|---|---|---|---|---|
| 1 | 18 500.0000 | ≥ 1 | 3 330.0000 | 21 830.0000 |
| 10 | 16 750.0000 | ≥ 10 | 30 150.0000 | 197 650.0000 |

A product created through a form, priced through a list created and populated through a form,
resolving at the correct volume slab with the correct GST split. And the negative case, which is the
one that matters: a product **absent** from the resolved list is refused with `409 PRICE_NOT_FOUND`,
never quietly quoted at zero — now asserted in the smoke suite.

## 12. The gate, after part 2

| | |
|---|---|
| `pnpm verify` | ✅ lint · typecheck · tests · build |
| Tests | **474** — 268 API (20 suites), 196 contracts, 10 web |
| Four `verify-*` harnesses | ✅ |
| `phase-8-smoke.sh` | ✅ 19/19 |
| `phase-9-smoke.sh` | ✅ 24/24 |
| `phase-11-forms-smoke.sh` | ✅ **48/48** (was 26) |

## 13. Still not done

- **Quotation, order, invoice issue, payment record/verify** — the remaining spine. Quotation and
  payment still have no detail page, and those pages are part of the work.
- **The line editor** is the largest remaining component, but `price-list-items.tsx` is now the
  working precedent: `useFieldArray`, one `EntityPicker` per row, `lineFields()` so an error on row 7
  lands on row 7. The sales version adds the live `POST /pricing/quote` preview and must never carry
  a price in the form (ADR-0011, §4.16).
- **Product periphery** — specifications, media, BOM, variants — still API-only, as are distributor
  KYC/agreements/notes/contacts and customer contacts.
- **Discount rules and tax rates** have no UI.
- **The invoice-issue warning in §7 stands unchanged.** `company.statutory.verified` is still `true`
  against placeholder numbers with three statutory numbers already burned. That is an owner decision
  before UAT reaches the issue form, not a code change.

### Dev fixtures created while verifying

`DIST-00003`, `CUST-00003`, `HTPL-RAKSHA-BEACON` and `PILOT-2026` were all made through the UI and
left in place. They are the states UAT will spend its time in — a partner awaiting approval, an end
customer, a DRAFT product, a published list with two volume slabs — and two smoke checks now read
them. They are hand-made rows, not seeded ones, so `pnpm db:reset` loses them and those checks fail
loudly rather than passing silently. Promoting them to `prisma/seed/` remains the follow-up.
