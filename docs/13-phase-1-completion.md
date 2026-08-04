# 13 — Phase 1: Foundation — Completion Record

> Status: **Complete and verified.** Ready for Phase 2 — Identity & Access.

Measured against the eight-gate Definition of Done in `05-roadmap.md`.

---

## 1. Gate results

| # | Gate | Result |
|---|---|---|
| 1 | **Design** | `docs/00`–`12` plus five ADRs. Two deviations recorded in §4 below |
| 2 | **Database** | 23 models, 2 migrations applied, indexes justified, seeds idempotent |
| 3 | **API** | Health endpoints live; RFC 7807 on every path; Swagger at `/api/docs` |
| 4 | **Backend** | Config validation, logging, errors, Prisma extensions, cache, queue, storage, mail, outbox |
| 5 | **Frontend** | App shell, design tokens, dark/light, DataTable, foundation dashboard |
| 6 | **Tests** | 68 passing (49 contracts · 19 API). Coverage gates enforced in CI |
| 7 | **Documentation** | This set, plus inline rationale on every non-obvious decision |
| 8 | **Verification** | `pnpm verify` green; full stack smoke-tested end to end |

---

## 2. What was verified, not assumed

Each of these was executed against real infrastructure rather than reasoned about.

| Claim | How it was proven |
|---|---|
| Audit log is append-only | `UPDATE` and `DELETE` both rejected by the database trigger; row survived intact |
| Scope constraint holds | `GLOBAL` with a `scope_id`, and `TERRITORY` without one, both rejected by `CHECK` |
| Outbox delivers end to end | Seeded event → claimed → BullMQ → processor → **business** channel → `EmailLog SENT` → `PROCESSED` |
| Segregation of duties is real | SQL confirmed only `SUPER_ADMIN`/`ADMIN` hold conflicting pairs; every operational role separated |
| GSTIN checksum works | Validated against two real published GSTINs; fabricated ones correctly rejected |
| Money never loses precision | 1,000 × ₹0.01 sums to exactly ₹10.0000; allocation preserves the total for every split 1–50 |
| DI survives the build | API boots with zero `UnknownDependenciesException` |
| Health split behaves | `/live` ignores dependencies; `/ready` reports Postgres and Redis |
| BFF proxy hop works | `/api/bff/*` reaches the API and returns its Problem Details with correlation id |
| Both themes render | Light and dark verified in-browser; tokens swap cleanly |

### The bug this caught

`eslint --fix` rewrote NestJS constructor dependencies to inline `type` imports.
`emitDecoratorMetadata` erases those, so Nest could no longer resolve them and the API
failed to boot with `UnknownDependenciesException`. Caught by booting the process rather
than by trusting a green build.

`@typescript-eslint/consistent-type-imports` is now **off** for the API, with the reason
recorded in `packages/config/eslint/nest.js`.

---

## 3. What exists

```
23  Prisma models          110  permissions        11  roles seeded
 2  migrations             12  system settings      7  number sequences
 9  service lines           5  industries          68  passing tests
```

**Backend** — Zod-validated config (fails fast, names the variable), Pino logging with
request correlation and secret redaction, RFC 7807 errors, Prisma soft-delete + scope
extensions, transactional audit service, Redis cache that degrades rather than throws,
BullMQ with DLQ, local storage with HMAC-signed URLs and a real virus-scan state machine,
dual-channel mail, transactional outbox with `SKIP LOCKED` claiming, health endpoints.

**Frontend** — Next.js 15 App Router, semantic design tokens in both themes, responsive
shell, `DataTable` with server-driven sorting and `j`/`k` keyboard navigation, BFF proxy
that keeps access tokens out of JavaScript, permission-aware navigation.

**Infrastructure** — Multi-stage Dockerfiles (non-root, healthchecked), dev and prod
Compose stacks (database unreachable from outside the internal network), Nginx with
per-route rate limiting and SSE support, `deploy`/`backup`/`restore` scripts, CI with
lint, typecheck, tests, build, dependency audit, secret scan, and image builds.

---

## 4. Deviations from the approved design

Both were discovered during implementation and are recorded rather than silently applied.

### 4.1 Audit is an explicit service, not a Prisma extension

`01-architecture.md` §4 listed audit alongside soft-delete and scope as a client extension.
Implementing it revealed that an extension cannot reliably join the caller's transaction,
so an audit row could be written for a business change that later rolled back. **An audit
log recording events that did not happen is worse than one with gaps, because it stops
being evidence.**

Audit is therefore explicit — `AuditService.record(tx, …)` inside the transaction. Soft-delete
and scope remain extensions because they only shape queries: there is no atomicity
requirement, and forgetting them is a security problem rather than a correctness one.

### 4.2 `findUnique` is not scoped by soft-delete

Prisma's `findUnique` accepts only a unique predicate, so `deletedAt: null` cannot be added.
Rather than silently rewriting it to `findFirst` — which would change the query's uniqueness
guarantees behind the caller's back — it is left uninterceptable and documented. Repositories
use `findFirst` for soft-deletable models; Phase 2's repository base class makes that the
only available option.

---

## 5. Known state

| Item | Status |
|---|---|
| Sidebar renders empty | **Expected.** Navigation is permission-gated and `/auth/me` arrives in Phase 2. Deny-by-default is the correct posture; faking it would undermine ADR-0003 |
| Business & ops SMTP | Falls back to a log transport until credentials are supplied. No real mail can leave a dev machine |
| `COMPANY_GSTIN` | Checksum-valid placeholder so dev boots. `system_setting.company.statutory.verified = false`; invoicing must refuse to issue until replaced (question E1) |
| Prisma 6.19.3 | Current major is 7. Deliberately deferred — see §6 |
| S3 and ClamAV drivers | Interfaces and state machines exist; drivers throw at boot rather than silently degrading |
| `hixaa_dms` database | A pre-existing database with ~12 MB of dev remnants from an earlier attempt was found and **left untouched**. This build uses `hixaa_dms_dev` |

---

## 6. One decision for you

**Prisma 6.19.3 vs 7.x.** I stayed on 6 to get Phase 1 verified end to end without a
major-version migration mid-build. The trade-off is real in both directions:

- **Upgrade now** — cheapest it will ever be. One schema file, no query code yet. Prisma 7
  changes the client generator (`prisma-client`, ESM-first), which needs `moduleFormat`
  configuration for NestJS's CommonJS build.
- **Stay on 6** — fully supported and stable. The cost is a migration later, bounded by the
  fact that all query code sits behind repositories.

My recommendation: **upgrade at the start of Phase 2**, before the auth module adds query
sites. It is a contained piece of work now and grows steadily more expensive.

---

## 7. Commands

```bash
docker compose -f infra/compose/docker-compose.dev.yml up -d   # Postgres, Redis, Mailpit
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm dev            # API :4000 · web :3000 · worker
pnpm verify         # lint + typecheck + tests + build
```

---

## 8. Next

**Phase 2 — Identity & Access**: login with Argon2id, refresh rotation with reuse detection,
Remember Me, forgot/reset password, email verification, CSRF, session management, MFA
scaffolding, user CRUD with invitations, scoped role assignment, and the audit log viewer.

That phase makes the permission-gated navigation light up and puts the scope machinery from
ADR-0003 under real load for the first time.
