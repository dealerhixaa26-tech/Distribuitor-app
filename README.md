# Hixaa DMS — Distributor Management System

**Hixaa Technologies Pvt. Ltd.** · Nagpur, Maharashtra
An enterprise Distributor Management System, architected to grow into a full ERP/CRM platform.

> **Current status: Phases 1–3 and 5 complete and verified.**
> Foundation, identity, master data, and the distributor channel are live. Scoped RBAC filters
> real rows across two entities, proven by denial.
>
> **Phase 4 (Catalog & Pricing) is the gap** and is now the critical path — see
> [docs/16-phase-5-completion.md](docs/16-phase-5-completion.md) §5–6.

---

## Quick start

Requires Node 24+, pnpm 10+, and either Docker or local PostgreSQL 16 and Redis 7.

```bash
docker compose -f infra/compose/docker-compose.dev.yml up -d
cp .env.example .env
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm dev
```

API on `:4000` (docs at `/api/docs`), admin portal on `:3000`, worker alongside.
`pnpm verify` runs the full gate: lint, typecheck, tests, build.

---

## Documentation

Read in order for the full picture, or jump to what you need.

| # | Document | What it covers |
|---|---|---|
| 00 | [Domain & Scope](docs/00-domain-and-scope.md) | Study of Hixaa's business, actors, core flows, invariants, glossary, NFRs, risks |
| 01 | [Architecture](docs/01-architecture.md) | System context, monorepo layout, layering, cross-cutting concerns, scalability plan |
| 02 | [Data Model](docs/02-data-model.md) | ~70 tables across 9 contexts, ER diagrams, index strategy, partitioning |
| 03 | [API Design](docs/03-api-design.md) | REST conventions, errors, pagination, idempotency, full endpoint catalogue |
| 04 | [RBAC & Permissions](docs/04-rbac-and-permissions.md) | Permission catalogue, roles, data scoping, segregation of duties, tokens |
| 05 | [Roadmap](docs/05-roadmap.md) | Phase-by-phase build plan with an 8-gate Definition of Done |
| 06 | [Security](docs/06-security.md) | Threat model, OWASP Top 10 coverage, uploads, secrets, audit |
| 07 | [Integrations](docs/07-integrations.md) | Dual email channels, Google Sheets backup, storage, search |
| 08 | [Frontend & UX](docs/08-frontend-and-ux.md) | Design tokens, `DataTable`, state, a11y (WCAG 2.2 AA), performance budgets |
| 09 | [Testing Strategy](docs/09-testing-strategy.md) | Test pyramid, coverage gates, CI pipeline |
| 10 | [Deployment](docs/10-deployment.md) | Hostinger VPS, Docker Compose, Nginx, backups, scripts |
| 11 | [Environment Variables](docs/11-environment-variables.md) | Every variable, documented and validated at boot |
| 12 | [**Recommendations**](docs/12-recommendations.md) | **What I recommend, the trade-offs, and what I need from you** |
| 13 | [Phase 1 completion](docs/13-phase-1-completion.md) | Foundation: what was built and verified, deviations |
| 14 | [Phase 2 completion](docs/14-phase-2-completion.md) | Identity & Access: verification, two bugs fixed |
| 15 | [Phase 3 completion](docs/15-phase-3-progress.md) | Master Data: scope activation and the three bugs it exposed |
| 16 | [**Phase 5 completion**](docs/16-phase-5-completion.md) | **Distributors: KYC gate, credit control, second scoped entity** |

### Architecture Decision Records

| ADR | Decision |
|---|---|
| [0001](docs/adr/0001-monorepo-with-shared-contracts.md) | Monorepo with a shared Zod contracts package |
| [0002](docs/adr/0002-ledger-based-inventory.md) | Ledger-based inventory instead of mutable counters |
| [0003](docs/adr/0003-scoped-rbac-for-future-distributor-portal.md) | Scoped RBAC enforced at the repository layer |
| [0004](docs/adr/0004-money-decimal-and-gst.md) | Money as `DECIMAL(18,4)`; strings on the wire |
| [0005](docs/adr/0005-transactional-outbox.md) | Transactional outbox for all side effects |
| [0006](docs/adr/0006-defer-prisma-7-upgrade.md) | Defer the Prisma 7 upgrade (reverses an earlier recommendation) |

---

## Stack

**Frontend** — Next.js 15 (App Router) · React · TypeScript · Tailwind · shadcn/ui · TanStack Query ·
React Hook Form · Zod · Recharts · Framer Motion

**Backend** — NestJS · TypeScript · Prisma · PostgreSQL 16 · Redis 7 · BullMQ · OpenAPI 3.1

**Infrastructure** — Docker Compose · Nginx · Let's Encrypt · Hostinger VPS

---

## Structure

```
hixaa-dms/
├─ apps/
│  ├─ api/          NestJS — REST API, workers, Prisma schema
│  └─ web/          Next.js — Admin Portal
├─ packages/
│  ├─ contracts/    Zod schemas — the single source of truth for every DTO
│  ├─ ui/           Shared design-system components
│  ├─ config/       Shared eslint / tsconfig / tailwind presets
│  └─ testing/      Factories and fixtures
├─ infra/
│  ├─ docker/       Dockerfiles + nginx.conf
│  ├─ compose/      docker-compose.{dev,prod,test}.yml
│  └─ scripts/      bootstrap · deploy · backup · restore · rollback
└─ docs/            This documentation set
```

---

## Design principles

1. **The backend is the product.** The Admin Portal is one client; the Distributor Portal and any
   mobile app consume the same API.
2. **Authorization is a data concern.** Every read is scoped at the repository layer. Hiding a
   button is presentation, never security.
3. **Ledgers over counters.** Stock and money are append-only with derived read models.
4. **Side effects go through the outbox.** No third-party call ever sits on a request path.
5. **One definition of a shape.** A DTO is one Zod schema, used by validation, OpenAPI, forms, and
   types.
6. **Nothing about the company is hardcoded.** Profile, branding, service lines, and industries are
   seeded data, editable from the Admin Panel.

---

## Signing in

After `pnpm db:seed`, the bootstrap administrator is the `SEED_SUPER_ADMIN_*` pair from your
`.env`. It is forced to change its password on first sign-in.

> Quote any secret containing `#` in `.env` — dotenv treats an unquoted `#` as a comment, so
> `pass#2026` silently becomes `pass`.

## Next step

**Phase 4 — Catalog & Pricing**, now the critical path: products with four types (goods,
service, kit, configurable), bills of materials so a Raksha IoT deployment explodes into its
components, technical specifications, versioned price lists with volume tiers, and the
date-effective GST engine. It also closes the two seams Phase 5 left open — distributor price
lists and the authorized product catalog.

Outstanding answers from [docs/12-recommendations.md](docs/12-recommendations.md) §E — Hixaa's
real GSTIN, the invoice number format your CA expects, the territory structure Hixaa actually
uses, the VPS plan, and brand assets. None block Phase 4; the GSTIN blocks invoicing in Phase 8.
