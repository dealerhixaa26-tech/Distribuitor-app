# 05 — Development Roadmap

> Phase 0 deliverable. Status: **Awaiting approval**

---

## How this roadmap works

Modules are built **one at a time, to completion**. A module is not "done" until all eight gates
below pass. Nothing moves to the next module with gates outstanding — that is how half-finished
modules accumulate and a codebase becomes untrustworthy.

### Definition of Done (every module, no exceptions)

| # | Gate | Evidence |
|---|---|---|
| 1 | **Design** | Module section in docs, decisions recorded |
| 2 | **Database** | Migration written, indexes justified, seeds idempotent |
| 3 | **API** | Endpoints implemented, OpenAPI generated and committed |
| 4 | **Backend** | Service + repository + guards + audit + outbox events |
| 5 | **Frontend** | List, detail, create/edit, empty/loading/error states, responsive, keyboard accessible |
| 6 | **Tests** | Unit (services), integration (API + real Postgres), E2E (critical path). Coverage ≥ 80% on service and domain layers |
| 7 | **Documentation** | Module README, API examples, permission matrix updated |
| 8 | **Verification** | Manual smoke against acceptance criteria; `pnpm verify` green (lint + typecheck + test + build) |

---

## Phase 0 — Design *(current)*

**Deliverables:** this documentation set — domain study, architecture, data model + ERD, API design,
RBAC, security, integrations, frontend spec, testing strategy, deployment plan, environment
variables, and five ADRs.

**Exit criteria:** your approval on the architecture, the schema, and the flagged recommendations
in `12-recommendations.md`. **No application code is written before this gate.**

---

## Phase 1 — Foundation *(no business features)*

The scaffolding everything else stands on. Deliberately unglamorous and deliberately first — every
shortcut taken here is repaid with interest in every module that follows.

| # | Item | Output |
|---|---|---|
| 1.1 | Monorepo | pnpm workspaces, Turborepo pipeline, shared tsconfig/eslint/prettier |
| 1.2 | `packages/contracts` | Zod primitives: `money`, `gstin`, `pan`, `hsn`, `pagination`, enums, permission keys |
| 1.3 | NestJS skeleton | Config with boot-time Zod validation, Pino logging, request IDs, Problem Details filter, health checks |
| 1.4 | Prisma + Postgres | Base schema, extensions (soft-delete, audit, scope), migration workflow |
| 1.5 | Redis + BullMQ | Queue registration, worker process, DLQ, retry policy |
| 1.6 | Storage abstraction | `StorageService` interface + Local driver (S3 driver stubbed) |
| 1.7 | Mail abstraction | Dual-transport `MailService` (BUSINESS / OPS), MJML templates, `EmailLog` |
| 1.8 | Outbox | `OutboxEvent` table, transactional emitter, dispatcher worker |
| 1.9 | Next.js skeleton | App Router, Tailwind, shadcn/ui, theme tokens, dark/light, layout shell |
| 1.10 | Design system | `<DataTable>`, `<PageHeader>`, `<FormField>`, `<EmptyState>`, `<StatusBadge>`, `<ConfirmDialog>`, toasts |
| 1.11 | Docker Compose | Local dev stack: Postgres, Redis, API, web, worker, Mailpit |
| 1.12 | CI | GitHub Actions: lint, typecheck, unit, integration (service containers), build |

**Exit:** `docker compose up` gives a running, empty, well-instrumented application; CI is green.

---

## Phase 2 — Identity & Access

| # | Module | Scope |
|---|---|---|
| 2.1 | **Auth** | Login, logout, Remember Me, refresh rotation + reuse detection, forgot/reset password, email verification, CSRF, Argon2id, lockout, session list/revoke, MFA-ready `MfaFactor` |
| 2.2 | **Users** | CRUD, invitations, suspension, profile, avatar |
| 2.3 | **Roles & Permissions** | Seeded catalogue, custom roles, scoped assignment, permission matrix UI, segregation-of-duties validation |
| 2.4 | **Teams** | Teams, membership, manager hierarchy |
| 2.5 | **Audit log** | Global capture, partitioned table, viewer UI with filters and export |

**Why second:** every subsequent module needs a current user, a permission, a scope, and an audit
trail. Building features first and retrofitting authorization is how authorization gaps ship.

**Exit:** a user can log in, be assigned a territory-scoped role, and every action they take appears
in the audit log with before/after state.

---

## Phase 3 — Master Data

| # | Module | Scope |
|---|---|---|
| 3.1 | **Geography** | Countries, states (with GST state codes), cities, addresses |
| 3.2 | **Territories** | Hierarchy, materialised path, manager assignment, tree UI |
| 3.3 | **Settings** | Company profile, branding, industries, numbering sequences, feature flags — plus seeding Hixaa's real portfolio data |
| 3.4 | **Documents** | Upload with magic-byte validation, checksum, virus-scan hook, linking, streamed authorized download |

**Exit:** Hixaa's company profile, service lines, and industries are in the database and editable
from the UI. Nothing about the company is hardcoded anywhere.

---

## Phase 4 — Catalog & Pricing

| # | Module | Scope |
|---|---|---|
| 4.1 | **Categories & brands** | Nested categories, media, ordering |
| 4.2 | **Products** | CRUD, four product types, variants, revisions, specifications, media (images/brochures/datasheets), HSN/SAC, warranty, FTS, bulk import/export |
| 4.3 | **BOM / kits** | Component assemblies, explosion on order |
| 4.4 | **Price lists** | Versioned lists, volume slabs, distributor assignment, clone, publish |
| 4.5 | **Discount rules** | Rule engine with priority resolution, `POST /pricing/quote` |
| 4.6 | **Tax** | Date-effective `TaxRate`, `GstCalculator` with an exhaustive test suite |

**Exit:** Raksha IoT exists in the catalog with real specifications, a brochure, a BOM, and a price
list; `POST /pricing/quote` returns the correct price and GST split for any distributor and quantity.

---

## Phase 5 — Distributors

| # | Module | Scope |
|---|---|---|
| 5.1 | **Distributors** | CRUD, GSTIN/PAN validation, lifecycle state machine, credit limit and terms |
| 5.2 | **Contacts & KYC documents** | Contacts, document upload, verification, expiry alerts |
| 5.3 | **Authorized catalog** | Which products each distributor may buy |
| 5.4 | **Agreements & notes** | Contracts, targets, timeline notes |
| 5.5 | **Distributor 360** | One screen: profile, orders, outstanding, stock, performance, documents, activity |
| 5.6 | **Bulk import** | CSV/Excel with row-level validation and an error report |

**Exit:** a distributor can be onboarded end to end, from lead to active with verified KYC.

---

## Phase 6 — Inventory

| # | Module | Scope |
|---|---|---|
| 6.1 | **Warehouses** | Company, distributor, transit, scrap types |
| 6.2 | **Stock ledger & balances** | Append-only ledger, transactional balance updates, row locking, non-negative constraint |
| 6.3 | **Receipts & adjustments** | Goods receipt, adjustments with reason codes and approval |
| 6.4 | **Batches & serials** | Batch lots, serial lifecycle, warranty windows, full trace lookup |
| 6.5 | **Transfers** | Two-phase dispatch/receive with visible transit stock |
| 6.6 | **Reservations** | Reserve on approval, release on cancel, consume on dispatch, expire stale |
| 6.7 | **Low stock** | Per-warehouse reorder levels, alerts, dashboard |
| 6.8 | **Reconciliation job** | Nightly re-derivation of balances from the ledger, drift alerting |

**Exit:** concurrent dispatch attempts on the last unit produce one success and one clean `409` —
verified by a concurrency test, not by inspection.

---

## Phase 7 — Sales

| # | Module | Scope |
|---|---|---|
| 7.1 | **Quotations** | Build, price, PDF, email, validity, revision, convert to order |
| 7.2 | **Orders (primary)** | Full FSM, credit check, discount approval, line-level snapshots, timeline |
| 7.3 | **Approvals** | Ceilings, escalation, self-approval prevention |
| 7.4 | **Shipments** | Packing, dispatch, stock issue, carrier/LR/vehicle, POD |
| 7.5 | **Orders (secondary)** | Distributor → customer sell-out, distributor stock decrement |
| 7.6 | **Customers** | CRUD, contacts, industry classification, installed base |

**Exit:** the complete order-to-dispatch flow works, with stock and credit correctly enforced at
every transition.

---

## Phase 8 — Finance

| # | Module | Scope |
|---|---|---|
| 8.1 | **Invoicing** | Draft → issue with gapless numbering, GST-compliant PDF, immutability |
| 8.2 | **Credit / debit notes** | The only correction path, linked to the original |
| 8.3 | **Payments** | Recording, verification (segregated), multi-invoice allocation, TDS |
| 8.4 | **Party ledger** | Statement of account, running balance, opening balances |
| 8.5 | **Outstanding & aging** | Buckets, overdue alerts, credit-limit enforcement |
| 8.6 | **GST returns** | GSTR-1 and GSTR-3B data export; e-Invoice/e-Way adapter interfaces (stubbed) |

**Exit:** a GST-compliant tax invoice can be issued, paid partially, aged, and corrected via credit
note — with the ledger balancing at every step.

---

## Phase 9 — Intelligence

| # | Module | Scope |
|---|---|---|
| 9.1 | **Dashboard** | KPI cards, sales trend, revenue, inventory health, recent activity |
| 9.2 | **Analytics** | Distributor performance, product performance, regional sales, target vs achievement |
| 9.3 | ~~**Materialised views**~~ | **Dropped — see ADR-0019.** Replaced by targeted indexes and the 5-minute Redis cache, after measuring the aggregates at 10× projected volume |
| 9.4 | **Reports** | Builder, saved reports, PDF/Excel/CSV export via background jobs |
| 9.5 | **Scheduled reports** | Cron definitions, emailed on the business channel |
| 9.6 | **Notifications** | In-app + email, preferences, SSE stream |
| 9.7 | **Global search** | Cross-entity Postgres FTS with a command palette (`⌘K`) |

---

## Phase 10 — Integrations & Operations

| # | Module | Scope |
|---|---|---|
| 10.1 | **Google Sheets backup** | Scheduled + manual export of the six required entities, checkpointed, chunked, quota-aware; restore with mandatory dry-run |
| 10.2 | **Ops email channel** | Deploy, backup, error, and monitoring notifications to the personal Gmail — strictly separate from business mail |
| 10.3 | **Database backups** | Nightly `pg_dump`, encrypted, off-box copy, documented and **rehearsed** restore |
| 10.4 | **Monitoring** | Health endpoints, uptime checks, error alerting, slow-query reporting |

---

## Phase 11 — Hardening & Release

| # | Item |
|---|---|
| 11.1 | Security review against `06-security.md`; dependency audit; secret scan |
| 11.2 | Load test: 100k distributors, 1M products, 5M order lines seeded; verify p95 targets |
| 11.3 | Accessibility audit — WCAG 2.2 AA, axe + manual keyboard and screen-reader pass |
| 11.4 | Production Compose, Nginx, TLS via Let's Encrypt, log rotation, resource limits |
| 11.5 | `deploy.sh`, `backup.sh`, `restore.sh`, `rollback.sh` — each tested on staging |
| 11.6 | Runbook: restore, rollback, credential rotation, incident response |
| 11.7 | UAT with real Hixaa users, feedback pass |
| 11.8 | Production launch |

---

## Post-v1 (recorded, not scheduled)

Distributor Portal · live e-Invoice/e-Way integration · SMS & WhatsApp · mobile apps ·
Meilisearch · multi-currency & export invoicing · service/AMC ticketing · Raksha IoT device
telemetry ingestion (a natural fit given the product line) · full ERP expansion.

---

## Sequencing rationale

The order is driven by **dependency, not by visibility**. It would be more satisfying to show a
dashboard in week two, but a dashboard needs orders, which need products and distributors, which
need territories and authorization. Building the visible things first forces every one of them to
be rewritten once the foundations arrive.

Two hard rules:

- **Authorization before features** (Phase 2 before Phase 4+) — retrofitting scoping onto existing
  queries is where security holes are born.
- **Inventory before sales** (Phase 6 before Phase 7) — an order that cannot reserve stock is a
  demo, not an order.
