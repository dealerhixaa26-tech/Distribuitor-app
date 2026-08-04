# HANDOFF — Hixaa DMS

> Everything a new session needs to continue this build without re-deriving it.
> Last updated at the end of Phase 4. Read this before touching code.

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
| **Branch** | `main` — clean, pushed, at `7cf5393` |
| **Size** | ~26,600 source lines · 50 tables · 6 migrations · 112 endpoints · 232 tests |
| **Gate** | `pnpm verify` green (lint, typecheck, tests, build) |

### Phase status

| Phase | State |
|---|---|
| 1 — Foundation | ✅ Complete — `docs/13-phase-1-completion.md` |
| 2 — Identity & Access | ✅ Complete — `docs/14-phase-2-completion.md` |
| 3 — Master Data | ✅ Complete — `docs/15-phase-3-progress.md` |
| 4 — Catalog & Pricing | ✅ Complete — `docs/18-phase-4-completion.md` |
| 5 — Distributors | ✅ Complete — `docs/16-phase-5-completion.md` |
| 6–11 | Not started — see `docs/05-roadmap.md` |

**Phase 6 (Inventory) is now the critical path.** Phase 4 closed both seams Phase 5 left open:
`Distributor.priceListId` is a real FK, and `DistributorProduct` is the authorized catalog.

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
| `support@hixaa.test` | `correct-horse-battery-staple` | SUPPORT_AGENT, 12 permissions |

The two non-admin accounts exist specifically to **test denial**. Use them.

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

## 5. Architecture in one screen

```
apps/api    NestJS · Prisma · PostgreSQL · Redis · BullMQ    :4000
apps/web    Next.js 15 App Router · TanStack Query           :3000
packages/contracts   ⭐ Zod schemas — the single source of truth for every DTO,
                        enum, and permission key. Used by API validation,
                        OpenAPI, React Hook Form, and both apps' types.
```

Six ADRs in `docs/adr/`. The ones that constrain daily work:

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

### Scoped entities so far
`SCOPE_REGISTRY` in `infrastructure/database/scope-registry.ts`:
`territory` (self, subtree-expanded), `warehouse`, `distributor` (by territory),
`distributorProduct` (via distributor). Commented-out entries mark where Phases 7–8 plug in.

The rest of the catalog — products, categories, price lists, discount rules, tax rates — is
company-wide reference data and deliberately NOT scoped.

---

## 6. What Phase 6 must deliver

From `docs/05-roadmap.md` §Phase 6, and see ADR-0002 — inventory is a **ledger plus a derived
balance, never a mutable counter**.

1. **Stock ledger** — append-only, signed quantities, one row per movement.
2. **Stock balance** — a derived read-model maintained in the same transaction, with
   `CHECK (quantity_on_hand >= 0)` as the last line of defence.
3. **Reservations** — stock committed to an approved order but not yet issued.
4. **Serial and batch tracking** — `Product.isSerialized` already drives this; a Raksha gateway in
   a confined space is a warranty and liability object.
5. **Transfers, adjustments, cycle counts.**

Reusable, already built: `ProductRelationsService.explode()` (reserve against an exploded kit),
`NumberSequenceService`, `keysetWhere`/`toListResult`/`parseSort`, `Money`, `DataTable`.

Register `stockLedgerEntry` / `stockBalance` in `SCOPE_REGISTRY` via warehouse, and prove refusal.

## 7. Open questions for the user

Still unanswered from `docs/12-recommendations.md` §E:

| # | Question | Blocks |
|---|---|---|
| E1 | Hixaa's **real GSTIN, PAN, CIN** | **Phase 8 invoicing** — `company.statutory.verified` is `false` and invoicing must refuse to issue while it is |
| E2 | Invoice number format the CA expects | Phase 8 |
| E3 | Warehouse list (how many, where) | **Phase 6 — now the critical path, ask before building** |
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
- **ClamAV and S3 drivers** — interfaces and state machines exist; both **throw at boot** if
  selected, rather than silently degrading.
- **Google Sheets backup** — designed in `docs/07-integrations.md`, not built (Phase 10).
- **Integration/E2E tests** — only unit tests exist (107). Testcontainers setup is specified
  in `docs/09-testing-strategy.md` but not wired.
- **`/api/v1/*` route warning** on boot is a harmless Nest 11 / Express 5 deprecation.

---

## 9. How to work on this

The user expects, and has consistently valued:

- **Design before code**, and recording *why* — ADRs for reversible-but-costly decisions.
- **Verification by execution**, not assertion. Boot the process, hit the endpoint, check the
  database. A green build has twice coexisted with a completely broken security control here.
- **Honest reporting** — say what is deferred and why; flag when a recommendation was wrong
  (ADR-0006 reverses an earlier one).
- **Comments that explain the reasoning**, not the mechanics.
- Phase completion records in `docs/` and a commit per phase, merged to `main` and pushed.
