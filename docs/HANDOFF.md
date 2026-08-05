# HANDOFF — Hixaa DMS

> Everything a new session needs to continue this build without re-deriving it.
> Last updated at the end of Phase 9. Read this before touching code.

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
| **Size** | ~55,000 source lines · 80 tables · 13 migrations · 230 endpoints · 368 tests |
| **Gate** | `pnpm verify` green (lint, typecheck, tests, build) |

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
| **10 — Integrations** | ❌ **NOT STARTED — now the critical path** |
| 11 — Deployment | ❌ Not started |

Phases were built 1→2→3→5→4→6→7: Phase 4 was skipped at the owner's request and picked up after 5.

**Phase 10 (Integrations) is now the critical path.** Both obligations Phase 8 placed on Phase 9
are discharged and proven — see `docs/26` §5.

🔴 **READ THIS FIRST: the worker did not boot between Phase 6 and Phase 9.** `worker.module.ts`
never imported `AuthModule`, whose `@Global` export `EncryptionService` is needed by
`DistributorsService`, which `InventoryModule` pulls in. Every worker start died with
`UnknownDependenciesException`. **The outbox dispatcher runs in the worker, so no domain event had
ever actually been dispatched** — 47 accumulated events fired on the first successful boot.
Fixed in Phase 9 (`docs/26` §3). **Anything that depends on the worker has therefore never run and
should be re-verified**, including the quotation email in §8 below.

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
pnpm dev                            # api :4000 · web :3000 · worker
pnpm verify                         # the gate: lint + typecheck + tests + build
```

### Dev credentials

| Account | Password | Role |
|---|---|---|
| `admin@hixaa.com` | `ChangeMe!Now#2026` | SUPER_ADMIN, GLOBAL |
| `west.manager@hixaa.test` | `vidarbha-automation-2026` | SALES_MANAGER, scoped to WEST zone |
| `support@hixaa.test` | `correct-horse-battery-staple` | SUPPORT_AGENT, global but low-permission |
| `west.storekeeper@hixaa.test` | `storekeeper-nagpur-2026` | INVENTORY_MANAGER, scoped to WEST zone |
| `west.accountant@hixaa.test` | `accounts-vidarbha-2026` | ACCOUNTS_EXECUTIVE, scoped to WEST zone |
| `finance.manager@hixaa.test` | `finance-nagpur-2026` | FINANCE_MANAGER, GLOBAL |

The five non-admin accounts exist specifically to **test denial**, and are seeded by
`prisma/seed/dev-users.seed.ts` (skipped in production) rather than living in one database.

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

## 5. Architecture in one screen

```
apps/api    NestJS · Prisma · PostgreSQL · Redis · BullMQ    :4000
apps/web    Next.js 15 App Router · TanStack Query           :3000
packages/contracts   ⭐ Zod schemas — the single source of truth for every DTO,
                        enum, and permission key. Used by API validation,
                        OpenAPI, React Hook Form, and both apps' types.
```

Twenty ADRs in `docs/adr/`. The ones that constrain daily work:

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

Seventeen live entries.

The rest of the catalog — products, categories, price lists, discount rules, tax rates — is
company-wide reference data and deliberately NOT scoped.

---

## 6. What Phase 10 must deliver

From `docs/05-roadmap.md` §Phase 10 — integrations and operations.

**Two things Phase 9 leaves for Phase 10** (`docs/26` §9):

- **Re-verify everything that depends on the worker.** It could not boot between Phase 6 and
  Phase 9 (§2 above), so the outbox dispatcher, the email processor, and the quotation-email
  handler in §8 have never actually run. Their state is unknown rather than known-good.
- **Wire the scheduled-report runner.** `ReportDefinition` stores a validated cron expression and
  recipients, and a CHECK refuses an active schedule with no recipients. Nothing executes it yet;
  it belongs with the worker's other `@Cron` jobs.

**Reuse, do not rebuild:** `ReportsService` (the catalogue and its CSV writer), `AnalyticsService`,
`NotificationsService` (already consuming the outbox), `OutstandingService`, `GstReturnsService`,
and `DocumentRendererService`.

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

- **UI is read-only.** Every list and detail view works; **create/edit forms are not built**.
  All mutations are API-complete and curl-verified. Forms are the largest single piece of
  outstanding frontend work.
- **MFA** — schema, config, and contracts exist. Login **fails closed** if a user has
  `mfaEnabled`. TOTP itself is not implemented.
- **Teams** — schema only, no CRUD.
- **Bulk import** — `importDistributorRowSchema` defined and tested; no endpoint.
- **Order amendment** — an approved order is frozen (ADR-0011); changing one is cancel-and-reraise
  until there is a documented amendment policy.
- **Backorder allocation is manual** — `POST /orders/:id/reserve` re-attempts it. Deliberate:
  allocating scarce stock between waiting customers is a commercial judgement (ADR-0012 §4).
- **Quotation email** — the outbox event fires on send and the PDF-attachment handler is still not
  written. ⚠️ Note that this was ALSO masked by the worker being dead (§2): re-verify rather than
  assuming the handler is the only thing missing. `GET /quotations/:id/pdf` works.
- **ClamAV and S3 drivers** — interfaces and state machines exist; both **throw at boot** if
  selected, rather than silently degrading.
- **Google Sheets backup** — designed in `docs/07-integrations.md`, not built (Phase 10).
- **Integration/E2E tests** — only unit tests exist (368: 196 contracts + 172 API). Every phase
  has instead been verified by booting the API and driving it with `curl` against a real database,
  which has repeatedly caught what unit tests could not. Testcontainers is specified in
  `docs/09-testing-strategy.md` but still not wired — this is the largest testing gap.
- **`/api/v1/*` route warning** on boot is a harmless Nest 11 / Express 5 deprecation.
- **Scheduled reports** — the schedule is stored and validated; no cron runner executes it (Phase 10).
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
  database. A green build has twice coexisted with a completely broken security control here, and
  Phase 8 found three more bugs this way after a clean typecheck (`docs/24` §3).
  `scripts/phase-8-smoke.sh` runs 19 such checks against a live API — re-run it rather than
  trusting the completion record.
- **Honest reporting** — say what is deferred and why; flag when a recommendation was wrong
  (ADR-0006 reverses an earlier one).
- **Comments that explain the reasoning**, not the mechanics.
- Phase completion records in `docs/` and a commit per phase, merged to `main` and pushed.
