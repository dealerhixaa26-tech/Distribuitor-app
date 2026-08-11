# HANDOFF — Hixaa DMS

> Everything a new session needs to continue this build without re-deriving it.
> Last updated during Phase 11, after the forms foundation. Read this before touching code.

---

## 1. What this is

A Distributor Management System for **Hixaa Technologies Pvt. Ltd.** (Nagpur, Maharashtra),
architected to grow into a full ERP/CRM.

The single most important domain fact, which shapes the whole schema:

> **Hixaa is a solutions and projects business, not an FMCG business.** One flagship product
> (**Raksha IoT** — confined-space worker safety), plus custom ATE, test benches, machine
> vision, DAQ, PCB design, and LabVIEW integration. Sold into thermal power, coal, mining,
> cement, and rail simulation, through an **RFQ-first** motion.

That is why the catalog needs `GOODS | SERVICE | KIT | CONFIGURABLE` product types, a bill of
materials, technical specification rows, SAC codes alongside HSN, and serial traceability —
not a flat SKU list. Source: hixaa.com, captured in `docs/00-domain-and-scope.md`.

---

## 2. Current state

| | |
|---|---|
| **Repo** | `/Users/sidhant/hixaa-app-new` |
| **Remote** | `https://github.com/dealerhixaa26-tech/Distribuitor-app.git` |
| **Branch** | `main` — clean, pushed |
| **Size** | ~61,000 source lines · 82 tables · 17 migrations · 237 endpoints · **474 tests** |
| **Gate** | `pnpm verify` green (lint, typecheck, tests, build) |

Tests are 268 API · 196 contracts · **10 web** (the web suite exists as of Phase 11; before that
`vitest run --passWithNoTests` ran nothing at all).

### Phase status

| Phase | State |
|---|---|
| 1 — Foundation | ✅ Complete — `docs/13-phase-1-completion.md` |
| 2 — Identity & Access | ✅ Complete — `docs/14-phase-2-completion.md` |
| 3 — Master Data | ✅ Complete — `docs/15-phase-3-progress.md` |
| 4 — Catalog & Pricing | ✅ Complete — `docs/17-phase-4-design.md` · `docs/18-phase-4-completion.md` |
| 5 — Distributors | ✅ Complete — `docs/16-phase-5-completion.md` |
| 6 — Inventory | ✅ Complete — `docs/19-phase-6-design.md` · `docs/20-phase-6-completion.md` |
| 7 — Sales | ✅ Complete — `docs/21-phase-7-design.md` · `docs/22-phase-7-completion.md` |
| 8 — Finance | ✅ Complete — `docs/23-phase-8-design.md` · `docs/24-phase-8-completion.md` |
| 9 — Intelligence | ✅ Complete — `docs/25-phase-9-design.md` · `docs/26-phase-9-completion.md` |
| 10 — Integrations | ✅ Complete — `docs/27-phase-10-design.md` · `docs/30-phase-10-completion.md` |
| **11 — Hardening & Release** | 🟡 **IN PROGRESS** |

Phases were built 1→2→3→5→4→6→7: Phase 4 was skipped at the owner's request and picked up after 5.

### Phase 11 progress

| Module | State |
|---|---|
| 11.1 Security review | ✅ `docs/31` — `/login` was an enumeration oracle past the lockout threshold; nodemailer 6→9 |
| 11.2 Load test | ✅ `docs/32` — 69 MB of GIN index nothing could use; 1212 ms → 5.7 ms. ADR-0019 re-measured and STANDS |
| **Create/edit forms** | 🟡 **`docs/33-phase-11-forms-foundation.md`.** Form kit · **distributor · customer · product · price list** create/edit, plus state transitions and the price-list slab editor. **Remaining: quotation · order · invoice issue · payment record/verify** |
| Idempotency | ✅ **CLOSED** — `IdempotencyInterceptor`, 15 money-moving routes, `docs/33` §8 |
| 11.3 Accessibility | ⬜ Deliberately after forms |
| 11.4–11.6 Deployment | ⬜ Written UNEXECUTED against a documented target (no VPS; ADR-0023 precedent) |
| 11.7 UAT · 11.8 launch | ⬜ |

✅ **Idempotency is now real.** `docs/03 §5` had promised it since Phase 0 with nothing implementing
it — the table, the error code, the purge job, the CORS allowance and the client option all existed
and the header was ignored. `IdempotencyInterceptor` now stores key + endpoint + body hash, replays
the stored response with `Idempotency-Replayed: true`, and refuses a reused key carrying a different
body. **It is the OUTERMOST interceptor** so it captures the enveloped, Decimal-as-string body the
client received; reverse it and a replay returns a Decimal as a JSON number.

⚠️ **The header is now REQUIRED on 15 routes**, so any caller that omits it gets a `422`. Mark a new
money-moving endpoint with `@Idempotent()`; `idempotency-coverage.spec.ts` fails the build if one in
the required set is missing it. Note the interceptor runs BEFORE the validation pipe — a smoke check
posting an empty body to `/orders` or `/payments` without a key gets a `422` about the header and
looks like it passed.

✅ **The worker is now observable.** It could not boot between Phase 6 and Phase 9 (`AuthModule`
never imported), and — found in Phase 10 — **`pnpm dev` never started it at all**, because
`turbo.json` had no `dev:worker` task. Both are fixed. It now writes a heartbeat every 30 seconds
and `GET /health/worker` returns **503** when it stops; every scheduled job records its own run at
`GET /health/jobs`. A dead worker is no longer indistinguishable from a healthy one.

🔴 **The Phase 10 lesson, which is the one to carry forward:** the danger in this system is not
failure, it is **success computed over an empty set**. Three cron jobs ran nightly, read an empty
database and reported `clean` for three phases (ADR-0021). Seven events reached a queue and were
silently discarded. A backup would have exported zero rows for four of six entities and recorded a
successful sync. None of it failed; all of it succeeded, doing nothing. Assert on **counts**, never
on "it ran".

---

## 3. Local environment — already set up, do not re-create

- **PostgreSQL 16 and Redis 7 run natively** via Homebrew. No Docker locally (`docker` is not
  installed). Compose files exist and are correct but are untested on this machine.
- Databases: **`hixaa_dms_dev`** (use this) and `hixaa_dms_test`.
- ⚠️ **`hixaa_dms` is a PRE-EXISTING database from an earlier attempt at this project**
  (~12 MB, plural table names, a few dozen rows). It has been **left untouched deliberately**.
  Do not migrate, drop, or write to it without asking.

```bash
pnpm install
pnpm db:migrate && pnpm db:seed     # idempotent
pnpm dev                            # api :4000 · web :3000 · worker · contracts watcher
pnpm verify                         # the gate: lint + typecheck + tests + build
pnpm dev:api / dev:web / dev:worker  # one at a time
```

⚠️ **Never run `pnpm build` while the dev watcher is running.** `nest-cli.json` sets
`deleteOutDir: true`, so it wipes `dist` under the running process and produces incoherent
behaviour — routes 404ing, stale handlers — that reads exactly like an application bug. Stop the
dev server first. This cost a confusing detour in Phase 10.

### Dev credentials

| Account | Password | Role |
|---|---|---|
| `admin@hixaa.com` | `ChangeMe!Now#2026` | SUPER_ADMIN, GLOBAL |
| `west.manager@hixaa.test` | `vidarbha-automation-2026` | SALES_MANAGER, scoped to WEST zone |
| `support@hixaa.test` | `correct-horse-battery-staple` | SUPPORT_AGENT, global but low-permission |
| `west.storekeeper@hixaa.test` | `storekeeper-nagpur-2026` | INVENTORY_MANAGER, scoped to WEST zone |
| `west.accountant@hixaa.test` | `accounts-vidarbha-2026` | ACCOUNTS_EXECUTIVE, scoped to WEST zone |
| `finance.manager@hixaa.test` | `finance-nagpur-2026` | FINANCE_MANAGER, GLOBAL |
| `west.analyst@hixaa.test` | `analyst-vidarbha-2026` | REGIONAL_ANALYST, scoped to WEST zone |
| `portal@nagpurautomation.test` | `portal-nagpur-2026` | DISTRIBUTOR_OWNER, scoped to `DIST-PORTAL-01` |

The seven non-admin accounts exist specifically to **test denial**, and are seeded by
`prisma/seed/dev-users.seed.ts` (skipped in production) rather than living in one database.

⚠️ **Use `west.analyst` for REPORT-scope tests.** It is the only account that is both
TERRITORY-scoped and holds `analytics:read:financial` — every report in the catalogue is financial,
so `west.manager` is refused on permission grounds and tells you nothing about scoping.

⚠️ **Use `west.storekeeper` for WRITE-scope tests, not `west.manager`.** `west.manager` holds
read-only inventory permissions, so an out-of-scope write returns 403 on PERMISSION grounds and
tells you nothing about scoping. That blind spot hid a real bug for two phases — see §4.14.

> ⚠️ **dotenv strips `#` and everything after it in an unquoted value.** `pass#2026` silently
> becomes `pass`. Always quote secrets containing `#`. This cost a debugging round already.

---

## 4. Non-obvious conventions — violating these silently breaks things

These are the ones that have actually caused bugs. Each is load-bearing.

### 4.1 Prisma model names are PascalCase at the extension boundary
Prisma passes client extensions `"Territory"`, not `"territory"`. Both the scope registry and
the soft-delete set are keyed camelCase, normalised through **`modelKey()`**
(`infrastructure/database/model-key.ts`). Getting this wrong made **both extensions silent
no-ops for two entire phases** — no scope filtering, no soft delete, nothing failing loudly.
Regression test: `model-key.spec.ts`, which asserts against `Prisma.dmmf` rather than literals.

### 4.2 Never call `.delete()` on a soft-deletable model
It **throws** by design, naming the method to use. Use `tx.model.softDelete({ id })`,
`softDeleteMany`, or `restore`. A `query` extension cannot rewrite one operation into another,
so the contract is explicit rather than magic.

### 4.3 Request context lives in MIDDLEWARE, not an interceptor
Nest runs **middleware → guards → interceptors → pipes → handler**. The auth guard populates
the context, so anything establishing it must run before guards.
`common/context/request-context.middleware.ts`.

### 4.4 A security control is not verified until something is REFUSED
The hard-won lesson. Permission checks passing does **not** mean row scoping works — they are
independent, and for two phases one worked while the other did nothing. When adding a scoped
entity, always test that an out-of-scope caller gets `404` on **read and write**.

### 4.5 Money is `DECIMAL(18,4)` and crosses the wire as a STRING
Never a JSON number (ADR-0004). The transform interceptor converts Decimal → string. On the
frontend use `Money.tryParse()` / `formatMoney()`, never `Number(value)`.

### 4.6 `@typescript-eslint/consistent-type-imports` is OFF for the API — leave it off
Its autofix rewrites NestJS constructor dependencies to type-only imports, which
`emitDecoratorMetadata` erases, turning every injection into `UnknownDependenciesException` at
boot. Reason recorded in `packages/config/eslint/nest.js`.

### 4.7 Services must not annotate wire types
Return types are inferred. The transform interceptor serialises `Date` → ISO string at the
edge, so a service annotated `Promise<XSummary>` (where the contract says `createdAt: string`)
will not typecheck.

### 4.8 All timestamps are `@db.Timestamptz(3)`
Prisma's `DateTime` defaults to a naive `timestamp(3)`. Migration 0003 converted 60 columns.
**Any new DateTime field must carry `@db.Timestamptz(3)`** or it reintroduces the bug where
raw-SQL `now()` comparisons are off by the session's UTC offset.

### 4.9 Shell `cd` does not persist reliably between tool calls
Use absolute paths. This has silently run commands in the wrong directory more than once.

### 4.10 `apiFetch` already unwraps the `{ data }` envelope for a SINGLE resource
It returns the envelope whole only when `meta` is present (i.e. for lists). So a detail page writes
`api.get<Thing>(path)` — **not** `.then(r => r.data)`. Double-unwrapping yields `undefined` and
renders an empty/not-found state against a **200 OK**. Types cannot catch it, because the generic
is whatever you claim it is. Cost a Phase 4 debugging round.

### 4.11 pg_trgm's `%` operator compares WHOLE strings
`similarity('Raksha IoT Gateway', 'raksah')` is **0.18** — below the 0.3 default threshold — because
a long name dilutes the match, so `name % 'raksah'` finds nothing and a typo-tolerant search is
silently dead code. Use **`word_similarity(query, target)`**, which scores against the closest word
and gives 0.57 for the same pair. See `products.service.ts` `searchIds()`.

### 4.12 A price is decided in exactly ONE place
`PricingService.quote()` (ADR-0007). Never read `PriceListItem.price` directly from a service —
that is how a quote and the invoice it becomes come to disagree by a few hundred rupees with no way
to say which is right. Phases 7 and 8 must call the engine.

---

### 4.13 Prisma will propose DROPPING raw SQL objects it does not know about
`migrate dev` diffs the whole database against `schema.prisma`. A **non-partial** index created in
raw SQL, or a GENERATED column, shows up as drift and the generated migration will try to remove
it. Partial indexes escape this (Prisma skips what it cannot model), which is why migration 0002's
survived and Phase 4's three product search indexes would have been destroyed by migration 0007.

Two rules follow:
- **Declare raw indexes in `schema.prisma`** — `@@index([col(ops: raw("gin_trgm_ops"))], type: Gin,
  map: "…")`. Then Prisma knows about them and stops proposing the drop.
- **Do not use GENERATED columns.** Use a BEFORE trigger instead. Behaviourally identical, and the
  column looks ordinary to the ORM. `product.search_vector` and `stock_balance.quantity_available`
  are both trigger-maintained for this reason (migration 0007).

After every migration, run `prisma migrate diff --from-migrations … --to-schema-datamodel …` and
confirm it says *"This is an empty migration."* Anything else is drift that will bite the next phase.

### 4.14 A write-scope test needs an account that is scoped AND has the permission
`west.manager` is territory-scoped but read-only on inventory, so every out-of-scope write returns
**403 on permission grounds** — which says nothing about whether row scoping guards writes. The two
controls are independent, and this blind spot hid a genuine bug for two phases: the scope extension
composed `update`/`delete` predicates into a shape Prisma rejects, so every scoped update 500'd for
a non-global caller (including editing a distributor, since Phase 5).

Use **`west.storekeeper@hixaa.test`** — scoped AND holding write permissions — so a refusal is
unambiguously a scope refusal. Seed an account of that shape for every new scoped module.

### 4.15 Stock is written in exactly ONE place
`StockLedgerService.move()` (ADR-0002). It takes `SELECT … FOR UPDATE` on the balance row BEFORE
reading the quantity — check-then-lock is the classic oversell bug and it reviews as correct. Never
write `stock_ledger_entry` or `stock_balance` from anywhere else; the ledger is append-only and a
database trigger will reject an UPDATE or DELETE regardless.

### 4.16 A REQUEST never carries a price
Quotation and order lines take product, quantity, and an optional override — never a price. Prices
are resolved server-side by `PricingService.quote()` and SNAPSHOTTED onto the line (ADR-0011). If a
client could post a price, the pricing engine would be advisory and every discount ceiling would be
trivially bypassable.

### 4.17 A library's README can be wrong; probe the package
pdfmake 0.3 documents `new PdfPrinter(fonts)` — a class that no longer exists. Two implementations
written from the docs typechecked and threw at the first render. The real API was found by reading
`js/index.js` and calling it. Applies to any dependency whose major version moved: check the
installed code, not the website.

### 4.18 A statutory document is frozen by the DATABASE, not by a service check
`invoice`, `tax_note` and `payment` all carry triggers that reject edits and deletes once issued or
verified (ADR-0016, migrations 0010–0011). The service checks stay too — they produce a good error
for a person; the triggers produce an ugly one for a code path nobody reviewed. **`DELETE` was
missed on the first pass** and only found because a psql cleanup step succeeded when it should have
failed. `invoice-immutability.spec.ts` now reads the trigger's column list out of the migration and
fails the build if a new money column escapes it.

### 4.19 The number sequence separator is PER SEQUENCE
`NumberSequence.separator`. Financial series (`INVOICE`, `CREDIT_NOTE`, `DEBIT_NOTE`, `PAYMENT`) use
`/`; everything else keeps `-`. It was hardcoded to `-`, which meant the invoice series would have
produced `HTPL/INV/2026-27-00001` while two documents promised `…/00001`. Changing a series after a
number has been issued is not possible — a gapless GST series cannot be renumbered — so **decide
the format before the first document exists**.

### 4.20 A model scoped by `type + id` cannot be scoped at all
`ledger_entry` shipped with `party_type` + `party_id`. Prisma has no correlated subquery, so a column
with no relation has nothing for the scope extension to nest through; the strategy written for it
referenced `EffectiveAccess` fields that do not exist and would have failed closed on every read.
Migration 0012 replaced the pair with two nullable FKs and a CHECK that exactly one is set — the
shape `invoice` and `payment` use — so `viaDistributorOrCustomer()` applies unchanged. **If a new
model can belong to one of two parents, give it two nullable foreign keys, not a discriminator.**

### 4.21 The ISSUE action is not the same as a status transition
`canTransitionInvoice('PAID', 'ISSUED')` is legitimately TRUE: a credit note offsetting everything
paid leaves an invoice issued and unsettled again. Guarding `issue()` with that table let a PAID
invoice be re-issued, burning a second statutory number before the trigger rejected it — a 500 with
a gap in the series. Guard the ACTION on `status !== 'DRAFT'`; use the table only for status moves.

### 4.22 `@Global` only reaches a composition that IMPORTS the module
`AuthModule` is `@Global` and exports `EncryptionService`. The API imports it, so the service is
available everywhere there. The WORKER never imported it — and `@Global` registers nothing in a
composition that has not imported the module at least once, so every worker boot died with
`UnknownDependenciesException` from Phase 6 until Phase 9. Providing the service at the worker's own
root does NOT fix it either: Nest resolves a dependency in **its own module's** context, so the
provider has to reach `DistributorsModule`. Import the module.

### 4.23 A process that fails at boot fails SILENTLY if nothing checks it
The above went unnoticed for three phases because the API boots independently and a dead worker's
only symptom is work not happening. **After changing module wiring, boot BOTH processes.**
`pnpm dev` starts them together; a `pnpm verify` pass says nothing about either.

### 4.24 Measure before building the fast version
`docs/08` §10 specified materialised views in Phase 0, before any data existed. Phase 9 measured the
aggregates at ten times a generous projection: the whole dashboard computes in ~108 ms. The views
were dropped (ADR-0019), and the doc that specified them now points at the ADR. **A performance
plan written before there is data to test is a hypothesis.**

### 4.25 A SYSTEM principal reads UNSCOPED — and that is why a report must not use it
`applyScope()` returns unfiltered for `actorType: 'SYSTEM'` (ADR-0021). Before that, `asSystem()`
produced a context with no `access`, which the extension treated as an unauthenticated request and
scoped to `id IN ()` — so **every background job read an empty database**. The nightly
reconciliation checked zero balances and reported `clean` for three phases.

The corollary matters as much as the fix: work that must stay scoped **must not run as SYSTEM**. A
scheduled report runs inside `RequestContextStore.asUser()` with its owner's resolved access, or it
would compute a territory manager's figures across every territory and email them.

### 4.26 Prisma is LAZY, so a context helper must AWAIT inside `storage.run`
`prisma.x.count()` builds a `PrismaPromise` that does not execute until awaited. A helper written
`storage.run(ctx, fn)` exits the context the moment `fn` returns an unresolved promise, so the scope
extension's hook fires **outside** it and `applyScope` — finding no context — returns the query
UNFILTERED:

```
asUser(p, () => prisma.distributor.count())        → 2   UNSCOPED
asUser(p, async () => prisma.distributor.count())  → 1   scoped
```

Same query, same user, different callback shape. `asUser` is `async` and awaits internally so the
shape cannot matter. **Any new context helper must do the same.** Harmless for `asSystem` by luck —
losing the context there yields the unscoped read it wanted anyway.

### 4.27 No string literal may key any table on the event path
An event clears three hand-keyed tables — `EVENT_QUEUE_ROUTING`, the processor's `case`, and
`EVENT_AUDIENCE`. Two were keyed by literal and drifted: `'stock.low'` where the constant is
`'inventory.stock_low'`, in **two independent places one function apart**, so fixing either alone
changed nothing observable. That is why it survived four phases.

Every case now matches `DOMAIN_EVENTS`. `EVENT_QUEUE_ROUTING` is
`Record<DomainEvent, QueueName | null>`, where `null` means "no consumer, by decision" as distinct
from absent meaning nobody noticed. `event-plumbing.spec.ts` makes the three tables prove they
agree — reintroducing the original typo fails to **compile**.

### 4.28 `tsx` cannot run Nest DI code
esbuild does not implement `emitDecoratorMetadata`, so `design:paramtypes` is never emitted and
every constructor injection resolves to `undefined`. It presents as an application DI bug and is
not one. Anything touching the Nest container lives in `src/scripts/` and runs **compiled**
(`node apps/api/dist/scripts/…`). `prisma/seed` gets away with tsx because it uses no DI.

### 4.29 A verification harness that swallows its own cleanup failure pollutes the database
`deleteMany` **throws** on a soft-deletable model (§4.2) — and a harness that wrapped cleanup in
`.catch(() => undefined)` left **sixteen** probe rows across runs while reporting success. Cleanup
must report failure, not hide it.

### 4.30 An exemption is only as narrow as the thing it recognises
`CsrfGuard` exempted callers with no session cookie — correct for a server-to-server client — and
recognised one by looking for the **refresh** cookie. That cookie is deliberately path-scoped to
`/…/auth`, so the browser never sends it to `/distributors`, so **every mutation the admin UI makes
skipped the CSRF check entirely.** Both halves were individually right. Measured, not reasoned:
a forged header returned `201`. It now triggers on the `csrf_token` cookie (`Path=/`). ADR-0026.

The general lesson: when a guard decides *whether to run*, test the negative case through the real
client path. A check that only asserts the happy request passes identically against a guard that
never executes.

### 4.31 Two actions ending in the same status cannot both be guarded by the transition table
`approve` and `reactivate` both reach `ACTIVE`. `PENDING_APPROVAL → ACTIVE` is legal — that is what
approval does — so guarding `reactivate()` with `assertTransition` alone handed it that move, and a
partner could be made ACTIVE **without verified KYC, without a GSTIN, without a contact**, with no
`onboardedAt` and no `distributor.approved` event. `approve` returned 409 and `reactivate` returned
ACTIVE on the same record, one second apart.

This is §4.21 generalised: guard the ACTION on its own precondition; use the table only for status
moves. `status-action-guards.spec.ts` finds every pair of actions sharing a destination and asserts
the narrower one names its own required status.

### 4.32 A form must validate what it will SEND, not what the DOM holds
The DOM says "nothing" with `''`; Zod says it with `undefined`. Validating raw form values checks a
payload the server will never see and refuses it for fields nobody was required to fill in — the
distributor form produced **twelve errors at once** for untouched optional fields. `contractResolver`
prunes with the same function the request uses, so the two cannot disagree. `NaN` counts as empty:
`valueAsNumber` yields it for a cleared number input and it survives every other check.

### 4.33 A `<select>` whose options load from an API must be CONTROLLED
An uncontrolled `register`ed select mounts before the options arrive, falls back to `''`, and never
picks its default up again. The billing-state field read empty on an edit form whose record plainly
had one — and that field decides place of supply, so saving would have posted an address without it.
Use `Controller` for any select fed by a query.

### 4.34 `apiFetch` returns TWO shapes, and a picker must handle both
It unwraps the `{ data }` envelope for a single resource but returns the envelope whole when `meta`
is present (§4.10). So a PAGINATED list yields `{ data, meta }` while a small reference lookup —
`/territories`, `/categories`, `/geography/uoms`, `/geography/industries` — yields the **bare array**.
Reading `.data` off both left every reference picker showing "No matches" against a `200 OK`, with
nothing in the console. The territory picker shipped broken for exactly this reason.

The shape also decides where filtering happens: a paginated endpoint has already applied `?q=`
server-side; a bare array IS the whole list and the endpoint ignored `q`, so it must be filtered in
the browser. `phase-11-forms-smoke.sh` pins which endpoints are which.

### 4.35 A detail response needs an `editable` projection or its edit form destroys data
Three times now — distributor, customer, product — the detail read model omitted fields the update
DTO accepts. An edit form pre-filled from it shows blanks that read as "nothing on file", and saving
writes them over real data, with a `200` both times. `product.uomId` was the sharpest: the summary
carries only `uomCode`, so **every save would have unset the unit**.

Add an `editable` block for any new editable entity, keep it OUT of the list projection (two address
joins per row on a 100k table for columns the list never shows), and never include a decrypted
secret — a blank field means "leave unchanged", which `update()` already honours for `undefined`.

### 4.36 An interceptor that stores a response must be the OUTERMOST one
Interceptor responses unwind outermost-last, so `IdempotencyInterceptor` is registered ahead of
`TransformInterceptor` to capture the enveloped, Decimal-as-string body the client actually
received. Reverse them and a replay returns a Decimal as a JSON number — ADR-0004's exact defect,
reachable only on the retry path. Interceptors also run BEFORE pipes, so a missing
`Idempotency-Key` is refused before body validation; a check expecting a validation `422` without a
key passes for the wrong reason.

---

## 5. Architecture in one screen

```
apps/api    NestJS · Prisma · PostgreSQL · Redis · BullMQ    :4000
apps/web    Next.js 15 App Router · TanStack Query           :3000
packages/contracts   ⭐ Zod schemas — the single source of truth for every DTO,
                        enum, and permission key. Used by API validation,
                        OpenAPI, React Hook Form, and both apps' types.
```

Twenty-six ADRs in `docs/adr/`. The ones that constrain daily work:

- **0002** Inventory will be a ledger + derived balance, never a mutable counter.
- **0003** Authorization is scoped at the **repository** layer via a Prisma extension, so
  forgetting to filter is impossible. This is what makes the future Distributor Portal a
  frontend project rather than a backend rewrite.
- **0004** Money is DECIMAL, strings on the wire.
- **0005** Side effects go through a transactional outbox. **No third-party call ever sits on
  a request path.**
- **0006** Prisma stays on 6.19.3. Prisma 7 requires mandatory driver adapters and relocates
  `dmmf`, `Decimal`, and the error classes — all load-bearing here. Revisit at Phase 11.
- **0007** ONE pricing pipeline. `PricingService.quote()` is the only place a price is decided;
  discounts never stack; a manual override is an audited input, not a bypass.
- **0008** Price lists are GST-EXCLUSIVE. Tax is derived forward, never backed out. `TaxRate` is
  date-effective and authoritative; `Product.gstRate` is a display snapshot only.
- **0009** Serial numbers are captured at DISPATCH, not receipt. A unit in stock is fungible; its
  identity is established when the warranty obligation attaches.
- **0010** Moving weighted-average costing, held on `stock_balance.averageCost`. Outbound movements
  never change it. Every ledger row stores the cost used at that moment, so history is never
  restated.
- **0011** Order and quotation lines SNAPSHOT their resolved pricing. Every input to a price is
  mutable by design, so a document re-priced against today's data is not what was agreed.
- **0012** Approval reserves what exists and BACKORDERS the rest. Dispatch is blocked per line.
- **0013** PDFs render with pdfmake, not headless Chrome — no Chromium on a single VPS.
- **0014** Channel inventory is DERIVED from dispatches, never self-reported. A sell-in dispatch
  posts two movements; what remains in a distributor warehouse is what that partner holds.
- **0015** The party LEDGER is the source of truth for what is owed — append-only, no balance table.
  DEBIT increases what the party owes. Per-invoice outstanding is materialised; a party balance is a
  SUM.
- **0016** Invoice immutability is enforced by a database TRIGGER, not a service check. The claim is
  frozen; the history of the claim (payments, cancellation, sending) is not.
- **0017** Credit and debit notes share ONE table with separate number series and separate routes.
  The sign lives in exactly one expression.
- **0018** VERIFYING a payment is the financial event; recording one is a memo with no ledger effect.
  Allocation requires a verified receipt, and the verifier may not be the recorder.
- **0019** Dashboard aggregates run ON DEMAND behind a 5-minute cache. **No materialised views** —
  measured at 10× projected volume before deciding. Reverses a Phase 0 assumption in `docs/08` §10.
- **0020** Reports are a fixed CATALOGUE with validated parameters, never a query builder. No user
  input becomes SQL, which is what keeps every report inside the scope extension.
- **0021** The SYSTEM principal reads UNSCOPED. "System" and "unauthenticated" stopped sharing a
  branch — conflating them meant every background job read `id IN ()` for three phases.
- **0022** An ops alert that cannot be delivered is still RECORDED (`EmailLog.UNDELIVERABLE`). An
  alerting path whose own failure mode is silence rebuilds the defect it exists to catch.
- **0023** Sheets goes through a port whose LOCAL adapter is real, not a mock — which is what let
  10.1 be executed and proven before credentials existed. Now also verified live.
- **0024** A backup is proven by RESTORING it, not by an exit code. Rehearsed, with row counts.
- **0025** Write forms are ROUTES, actions are DIALOGS, and one kit serves both. A form may not
  contain a price. Every server field error either lands on a field or is shown in the summary.
- **0026** CSRF enforcement triggers on the CSRF cookie, not the path-scoped refresh cookie —
  which had made the whole control unreachable for every mutation the UI makes. See §4.30.

### Scoped entities so far
`SCOPE_REGISTRY` in `infrastructure/database/scope-registry.ts`:
`territory` (self, subtree-expanded), `warehouse`, `distributor` (by territory),
`distributorProduct` (via distributor), and the Phase 6 inventory models —
`stockBalance`, `stockLedgerEntry`, `stockReservation`, `inventorySetting`, `stockCount`
(all via warehouse), `serialNumber` (by distributor, because a dispatched serial has no
warehouse), and the Phase 7 sales models — `order` and `quotation` (via distributor OR customer,
since a SECONDARY order has no distributor), `shipment` (via warehouse), `customer` (by territory),
and the Phase 8 finance models — `invoice` and `payment` (via distributor OR customer, reusing the
Phase 7 strategy unchanged), `taxNote` (via the invoice it corrects), and `ledgerEntry` (which had to
have its columns reshaped in migration 0012 before it could be scoped at all — see §4.20).

Eighteen live entries.

The rest of the catalog — products, categories, price lists, discount rules, tax rates — is
company-wide reference data and deliberately NOT scoped.

---

## 6. What Phase 11 must deliver

From `docs/05-roadmap.md` §Phase 11 — hardening and release: security review, load test at
100k distributors / 1M products / 5M order lines, WCAG 2.2 AA audit, production Compose + Nginx +
TLS, `deploy.sh` / `rollback.sh`, the runbook, UAT, launch.

**Phase 10's one obligation is DISCHARGED.** `REGIONAL_ANALYST` (TERRITORY-scoped, holds
`analytics:read:financial`) and `west.analyst@hixaa.test` close the seed gap, and
`verify-scheduled-reports.js` check 5 now proves report scoping through a **full scheduled run**:
`analyst(west) sees 1 vs admin(global) sees 2`. Phase 11 starts with no inherited obligations.

**Reuse, do not rebuild:** the six `verify-*.ts` harnesses in `apps/api/src/scripts/`,
`scripts/backup.sh` and `restore.sh`, `JobHeartbeatService.track()` for any new scheduled job, and
`SheetsPort.probe()` for reachability checks.

## 7. Open questions for the user

Still unanswered from `docs/12-recommendations.md` §E:

| # | Question | Blocks |
|---|---|---|
| **E1** | Hixaa's **real GSTIN, PAN, CIN** | 🟡 **STILL OPEN, no longer blocking.** Owner chose to build against placeholders. Invoicing refuses to ISSUE while `company.statutory.verified` is false, and that refusal is proven. Supplying the real numbers is a **settings write** — no code change, no migration. Until then **no real invoice can be issued** |
| ~~E2~~ | ~~Invoice number format~~ | **ANSWERED**: `HTPL/INV/2026-27/00001`. Live — the first issued invoice carries it. ⚠️ Assumes **no manual GST invoices exist for FY 2026-27**; if any do, advance `number_sequence.next_value` past the last filed number BEFORE issuing (`docs/24` §9) |
| ~~E3~~ | ~~Warehouse list~~ | **ANSWERED**: one, at Nagpur. Seeded as `WH-NGP` |
| E4 | Real territory structure | Seeded 5 zones as a guess; editable |
| E5 | Hostinger VPS plan; is Docker installed | Phase 11 |
| ~~E8~~ | ~~Existing product/price data~~ | **ANSWERED**: none to import; catalog seeded from the portfolio, pricing made situational |
| E9 | Payment terms actually used | Phase 5 defaults seeded |
| E10 | Logo SVG + brand hex values | Cosmetic; placeholder `#0057B8` in use |

---

## 8. Known gaps (deliberate, not forgotten)

- **DISTRIBUTOR, CUSTOMER, PRODUCT and PRICE LIST are writable** end to end through the browser,
  with state transitions and the price-list slab editor (`docs/33`). The form kit is in
  `apps/web/src/components/form/` — `Field`, `Select`, `EntityPicker`, `AddressFields`,
  `MoneyInput`/`QuantityInput`/`DateInput`, `FormDialog`/`ConfirmDialog`, `SubmitBar` — plus
  `lib/form-errors.ts` and `lib/use-entity-mutation.ts` (`contractResolver`, `pruneEmpty`).
  **Still to build: quotation · order · invoice issue · payment record/verify.** Read ADR-0025
  before adding one; §4.32–4.35 are the traps that each cost a debugging round.
- **Quotation and payment have no DETAIL page.** "Send a quotation" and "verify a payment" are
  detail-page actions, so those pages are part of the remaining forms work, not separate from it.
- **`price-list-items.tsx` is the precedent for the sales line editor** — `useFieldArray`, one
  `EntityPicker` per row, `lineFields()` so an error on row 7 lands on row 7. The sales version adds
  the live `POST /pricing/quote` preview and must never hold a price in the form (ADR-0011, §4.16).
- **The periphery is still API-only**: distributor KYC/agreements/notes/contacts, product
  specifications/media/BOM/variants, customer contacts, discount rules, tax rates. Deliberate — the
  spine comes first.
- **MFA** — schema, config, and contracts exist. Login **fails closed** if a user has
  `mfaEnabled`. TOTP itself is not implemented.
- **Teams** — schema only, no CRUD.
- **Bulk import** — `importDistributorRowSchema` defined and tested; no endpoint.
- **Order amendment** — an approved order is frozen (ADR-0011); changing one is cancel-and-reraise
  until there is a documented amendment policy.
- **Backorder allocation is manual** — `POST /orders/:id/reserve` re-attempts it. Deliberate:
  allocating scarce stock between waiting customers is a commercial judgement (ADR-0012 §4).
- ~~**Quotation email**~~ — ✅ **DONE.** The handler attaches a real 34 KB PDF; `invoice.issued` and
  `distributor.approved` too. Recipients resolve through the contact tables, since neither
  `distributor` nor `customer` carries a top-level email.
- **ClamAV and S3 drivers** — interfaces and state machines exist; both **throw at boot** if
  selected, rather than silently degrading.
- ~~**Google Sheets backup**~~ — ✅ **DONE and running live against Google.** `docs/28` is the setup
  guide. Sheets is a CONVENIENCE copy; `pg_dump` (`docs/29`) is the recovery mechanism. Applying a
  Sheets *restore* is refused by design — see ADR-0024.
- **Integration/E2E tests** — only unit tests exist (368: 196 contracts + 172 API). Every phase
  has instead been verified by booting the API and driving it with `curl` against a real database,
  which has repeatedly caught what unit tests could not. Testcontainers is specified in
  `docs/09-testing-strategy.md` but still not wired — this is the largest testing gap.
- **`/api/v1/*` route warning** on boot is a harmless Nest 11 / Express 5 deprecation.
- **`MAIL_OPS_TO` is unset**, so every ops alert is recorded `UNDELIVERABLE` in `email_log` rather
  than delivered (ADR-0022). Visible now rather than silent — but nothing is actually emailed.
  Setting it is a config change, no code. **Production refuses to boot without it.**
- **No point-in-time recovery.** Nightly `pg_dump` only; up to 24h loss worst case. WAL archiving is
  a Phase 11 decision to take with the VPS layout (`docs/29` §8).
- **Sheets retry/backoff is unexercised.** The live runs never approached the quota, so it is the
  least-tested code in the adapter (`docs/28` §7).
- ~~**Scheduled reports**~~ — ✅ **DONE.** A minute-by-minute sweep over `nextRunAt`. Reports run as
  their OWNER, never as SYSTEM (§4.25).
- **XLSX / PDF report export** — CSV works end to end; the other formats are accepted and not rendered.
- **SSE notifications** — deliberately polled instead; a Phase 11 decision (`docs/26` §6).
- **e-Invoice / e-Way Bill** — columns (`irn`, `ackNumber`, `signedQrCode`, `ewayBillNumber`) and the
  adapter seam exist; no live GSP calls. Hixaa's turnover does not require e-invoicing yet.
- **GSTR-2A/2B reconciliation** — purchase-side, and there is no purchase document in the schema.
  GSTR-3B table 4 returns zeros **with an explicit note** rather than being omitted.
- **Seed inconsistency**: `DIST-00002` is named "Chennai Process Controls", sits in the Tamil Nadu
  territory, and carries a Karnataka (`29`) GSTIN. Place of supply derives from the GSTIN, so its
  invoices show Karnataka. Tax logic is correct; the fixture contradicts itself (`docs/24` §9).

---

## 9. How to work on this

The user expects, and has consistently valued:

- **Design before code**, and recording *why* — ADRs for reversible-but-costly decisions.
- **Verification by execution**, not assertion. Boot the process, hit the endpoint, check the
  database. A green build has twice coexisted with a completely broken security control here;
  Phase 8 found three more bugs this way after a clean typecheck (`docs/24` §3), and Phase 9 found
  that **the worker had not booted for three phases** (§2 above).
  Three smoke suites live in `scripts/` — `phase-8-smoke.sh` (19), `phase-9-smoke.sh` (24), and
  `phase-11-forms-smoke.sh` (48, which drives the **BFF on :3000** rather than the API, because
  that is the path a form takes and where the CSRF control turned out to be unreachable).
  Seven harnesses in `apps/api/src/scripts/`, run COMPILED (§4.28): `verify-worker-jobs` ·
  `verify-backup` · `verify-sheets-connection` · `verify-db-backup` · `verify-monitoring` ·
  `verify-scheduled-reports` · `verify-search-perf`.
  **Re-run them rather than trusting a completion record** — doing exactly that at the start of the
  forms work turned up six defects, two of them security-relevant, and one check that had never
  executed since the day it was written (`docs/33` §2) — then three more, including a picker that had
  shipped silently empty (`docs/33` §10).
- **Measure before building the fast version.** ADR-0019 dropped the materialised views `docs/08`
  §10 had specified in Phase 0, after timing the aggregates at 10× projected volume. A performance
  plan written before there is data to test it against is a hypothesis, not a decision.
- **Honest reporting** — say what is deferred and why; flag when a recommendation was wrong.
  Two ADRs now reverse earlier decisions: **0006** (defer the Prisma 7 upgrade) and **0019**
  (no materialised views). Both say plainly what changed and why.
- **Comments that explain the reasoning**, not the mechanics.
- Phase completion records in `docs/` and a commit per phase, merged to `main` and pushed.
