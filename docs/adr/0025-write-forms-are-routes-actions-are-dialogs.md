# ADR-0025 — Write forms are routes, actions are dialogs, and one kit serves both

- **Status:** Accepted
- **Date:** 2026-08-11

## Context

Every list and detail view in the admin portal works. Nothing can be created or edited. Eight pages
carry a "New …" button wired to nothing. The mutations behind them are complete, curl-verified, and
gated — this is missing UI, not missing backend.

The UI kit that exists is `Button · Input · Textarea · Card · Skeleton · EmptyState · StatusBadge ·
DataTable`. There is no select, no combobox, no dialog, no date or money input, and no wrapper that
pairs a label with a control and its error. There is exactly one form in the application (login) and
one mutation (running a report). Radix's dialog, select, popover and label packages, `react-hook-form`,
`@hookform/resolvers` and `sonner` are all installed and entirely unused.

So the shape of the work is decided now, once, rather than six times by accident. Three questions
have to be answered before the first form: where a form lives, what it is allowed to contain, and how
a server's refusal reaches the field that caused it.

The forms themselves vary enormously. Creating a distributor is thirty-odd fields including two
nested addresses, banking details, and a cross-field rule tying PAN to GSTIN. Verifying a payment is
a note and a confirmation. Issuing an invoice is a button with consequences. Treating those as one
kind of thing produces either a modal nobody can fill in or a page for every button.

## Decision

### 1. A form that creates or edits an entity is a ROUTE. An action on an existing entity is a DIALOG.

`/distributors/new` and `/distributors/[id]/edit` are pages. Approving, suspending, or changing a
credit limit are dialogs on the detail page.

The dividing line is not size, it is what the user is doing. Creating a distributor is a task someone
starts, gets interrupted during, and returns to; it deserves a URL that can be linked, refreshed,
and reopened, and it must survive a validation failure without a modal's state evaporating.
Approving one is a decision taken *about a record you are already looking at* — sending that to
another page loses the context the decision depends on.

Practically: routes for distributor, product, price list, quotation, order, payment. Dialogs for
every state transition, for the short forms hanging off a detail page (contacts, notes), and for
customer creation, which is small and is most often needed mid-flow while raising an order.

### 2. A form may not contain a price.

Quotation and order lines take product, quantity, and an optional override carrying a mandatory
reason — never a price (ADR-0011, HANDOFF §4.16). The line editor shows a live total by calling
`POST /pricing/quote` and rendering what comes back. The client displays the price; it never holds
one, and it never submits one.

This is the same rule the API already enforces, restated where it is easiest to break. A form that
displays an editable total and posts it would make `PricingService.quote()` advisory and every
discount ceiling bypassable, and it would look completely reasonable in review.

### 3. One kit, built before the first form.

`Field` (label, control, description, error, `aria-invalid` and `aria-describedby` wired together),
`Select`, `EntityPicker` (searchable async lookup over a list endpoint), `MoneyInput`, `DateInput`,
`FormDialog`, `SubmitBar`, and a `useEntityMutation` hook.

The login page already establishes the accessibility pattern — `aria-invalid` driven from state,
`aria-describedby` pointing at the error, `role="alert"` on the summary. Extracted once, it is right
everywhere. Hand-wired six times it will be right in four places, and 11.3's accessibility audit will
find the other two. Building the kit is cheaper than the second form.

### 4. Every server field error either lands on a field or is shown in the summary.

`setError` accepts any name at all. An error naming a field the form does not render — a rule about
a column the UI never exposes, or one a narrower edit form omits — is stored where nothing reads it.
The form then refuses to submit and displays nothing, so the button appears to do nothing at all.

So `applyServerErrors` places an error only on a field the form declares, and returns everything else
in `unattributed` for the form-level summary. No refusal is silently dropped, and a unit test asserts
the message **arrives at a named field** — read back through RHF's own `get`, not from a call log.
Asserting "the bridge ran" would pass against a bridge that files everything into the void.

> **A correction, recorded because it shaped this decision.** The first version of this section
> claimed the API's bracket paths (`lines[0].productId`) were incompatible with RHF's dotted paths
> and that line-item errors were being silently dropped. That was **wrong**. RHF's `stringToPath`
> splits on `/[.[\]'"]/`, so both forms resolve to the same field; `form-errors.spec.ts` pins this
> against the installed version. Paths are still canonicalised, but for a smaller and real reason:
> `applyServerErrors` compares them as **strings** against the form's field list, and
> `'lines[0].productId' === 'lines.0.productId'` is false. Without one canonical form, every
> array-line error would be misclassified as unattributable.

## Consequences

**Roughly thirteen new routes and twenty components**, sequenced so the kit lands first and the
hardest ordinary form (distributor) proves it before the rest become assembly.

**Two entities need a detail page before they can have actions.** Quotation and payment have lists
and nothing else, but "send a quotation" and "verify a payment" are detail-page actions. Those pages
are part of the forms work, not separate from it.

**Customer creation moves ahead of quotation and order.** A `SECONDARY` order is refused without a
`customerId`, and the customers page has only a dead button — so it blocks the order form.

**The periphery stays API-only for UAT**, and is recorded as such rather than quietly omitted: KYC
upload, agreements, notes, BOM, specifications, media, discount rules, tax rates, and shipments.

**Permission-gated buttons remain presentation, never security** (`usePermission`, docs/04 §5). Every
form targets an endpoint that independently enforces the same permission and the same row scope. The
rule holds: if the button were visible, clicking it would still be refused by the API.

**Verification is by driving the real thing.** There are no web tests in this repo and no
Testcontainers; every phase so far has been proven by booting the stack and exercising it. Forms are
verified the same way — created rows counted in the database, refusals asserted for an out-of-scope
actor — with unit tests only where pure logic warrants them, such as the error-path bridge.
