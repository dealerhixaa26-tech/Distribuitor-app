# 30 — Phase 10 completion: Integrations & Operations

> Design in `docs/27-phase-10-design.md`. Everything below was verified by execution against a
> real database and, where applicable, a real third-party API — not by a passing typecheck.

---

## 1. What shipped

| # | Module | State |
|---|---|---|
| — | **Worker re-verification** | ✅ Done first, as instructed. Found three defects, two older and larger than the one Phase 9 fixed |
| §2 | **Event plumbing** | ✅ Routing table exhaustive at the type level; seven silently-dropped events fixed |
| 10.1 | **Google Sheets backup** | ✅ Built against a real local adapter, then **run live against Google** |
| 10.2 | **Ops email channel** | ✅ Undeliverable alerts are recorded; production refuses to boot without a recipient |
| 10.3 | **Database backups** | ✅ Encrypted `pg_dump`, and the restore **actually rehearsed** |
| 10.4 | **Monitoring** | ✅ Worker heartbeat; a dead worker is now detected |
| §7 | **Scheduled report runner** | ✅ Runs as the report's owner, not as SYSTEM |

**Scale:** ~55,700 source lines · 82 tables · 17 migrations · 236 endpoints · **438 tests**
(238 API + 196 contracts + 4 context) · 24 ADRs · `pnpm verify` green · no schema drift.

---

## 2. The defects verification found

Phase 9 said "re-verify everything worker-resident, because none of it has ever run." That was the
right instruction and it paid for itself several times over.

### 2.1 `pnpm dev` never started the worker

`turbo.json` had no `dev:worker` task, so no aggregate command invoked it — `apps/api`'s `dev`
script is the **API**. HANDOFF §3 documented `pnpm dev # api · web · worker`, and §4.23 told you to
"boot BOTH processes; `pnpm dev` starts them together."

That instruction could not work. So even after Phase 9 fixed the `AuthModule` import, anyone
following the documented workflow still ran with **no worker**. The remedy written into the handoff
was itself broken.

Also cleared: **20 stale processes** accumulated across sessions, including four concurrent workers
contending on the outbox `FOR UPDATE SKIP LOCKED` claim — the source of the `Slow query` warnings.

### 2.2 Every background job read an empty database (ADR-0021)

`applyScope()` returns unfiltered when there is **no** context, but `id IN ()` when a context exists
with no `access` — a branch written to fail closed on unauthenticated HTTP requests. `asSystem()`
produces exactly that shape.

Proven by running each job twice and comparing:

```
as the cron runs it:   checked 0, clean=true
with scope bypassed:   checked 2, clean=true
actually in the table: 2
```

- **`reconcileStock`** — ADR-0002's drift alarm checked zero balances and reported `clean`. It was
  **structurally incapable of firing** and would have reported success forever.
- **`expireStaleReservations`** — never released stock.
- **`alertLowStock`** — never alerted. The first run after the fix raised **two real suppressed
  alerts**: `HTPL-RAKSHA-TAG` at 0 against a reorder level of 100, and `HTPL-DAQ-16` at 0 against 2.

The irony is exact: had the jobs run with *no* context they would have worked. Establishing a system
identity — done so audit rows are never anonymous — is what blinded them.

### 2.3 Seven events reached a queue and evaporated

An event had to clear **three** hand-keyed tables to reach a person — the routing table, the
processor's `case`, and the notification audience map — two of them keyed by **string literal**, and
nothing checked they agreed.

`EVENT_QUEUE_ROUTING` carried the comment *"Exhaustive by construction."* It was
`Record<string, QueueName>`, which checks nothing.

**The part worth remembering:** fixing `NotificationsProcessor.describe()` did **not** make
low-stock work. `EVENT_AUDIENCE`, one function away, held a *second independent copy* of the same
typo — also `'stock.low'` where the constant is `'inventory.stock_low'` — plus
`'distributor.catalog.changed'` for `distributor.catalog_changed`. Fixing either alone changed
nothing observable, which is exactly why it survived four phases: each partial fix looked like it
had failed.

So the rule is not "fix the typo" but **no string literal may key any table on the event path**.
`event-plumbing.spec.ts` makes the three tables prove they agree; reintroducing the original typo
now fails to **compile**.

| Event | Before | After |
|---|---|---|
| `quotation.sent` | nothing | email + `QT-…pdf` (34,163 b) |
| `invoice.issued` | nothing | email + `HTPL-INV-…pdf` (34,115 b) |
| `distributor.approved` | nothing | email to resolved contact |
| `inventory.stock_low` | 0 notifications | **2** |
| `distributor.catalog_changed` | 0 | **7** |
| `payment.verified` | 0 | **6** |
| `security.token_reuse_detected` | no record at all | `UNDELIVERABLE` row |

### 2.4 The worker DI trap, twice more

Adding `DocumentRendererModule` killed the worker at boot with a **completely clean typecheck** — it
needs `SettingsService`, and `SettingsModule` is `@Global`, which registers nothing in a composition
that never imported it. That is **HANDOFF §4.22 verbatim**, the convention written after the last
time this happened, catching the very next module added to the worker.

`IntelligenceModule` then failed the same way for `ReportsService`, which it provided but did not
export.

Both found by booting. Neither was visible to `tsc`.

---

## 3. 10.1 — Google Sheets, live

Built against `LocalFileSheetsAdapter` (ADR-0023), then the owner supplied credentials mid-phase and
it ran against the real API.

**It worked on first contact.** Authentication, sheet creation, chunked append, staging swap,
read-back and the restore diff all succeeded with no code change. ADR-0023 predicted trouble in
exactly those places; the ADR now records that the prediction was pessimistic rather than quietly
dropping it.

```
Users 7/7 · Products 14/14 · Distributors 2/2 · Orders 5/5 · Payments 10/10 · Inventory 2/2
```

Both failures were **configuration**, and both are now called out in `docs/28`:
`SHEETS_ENABLED=True` (the parser takes `true|false|1|0`, so the API refused to boot, correctly) and
an unquoted private key that survived only because a PEM body contains no `#`.

**One real bug, visible only because it ran.** `SyncJob.apiRequests` recorded the adapter's running
*process* total — 112, 120, 128, 136, 144, 152, 160 across six entities, reading as though the last
cost 160 requests when it cost 8. Now a per-job delta. The local adapter could never have exposed
this.

Measured: **8 requests per entity, ~48 per full backup** against a 250/min limiter, ~4 s per entity
of API latency.

Two paths did not exercise on the first run and were forced rather than assumed: no distributor had
bank details (seeded one → `1 on file, 1 [redacted], 0 leaked`, then reverted), and 14 rows against
a batch size of 1000 meant chunking never engaged (re-ran at `SHEETS_BATCH_SIZE=3` → Products 14
rows in **5 batches**, every batch checkpointed).

**The guard that ties back to §2.2:** `rowsExpected` is counted before the run, and exporting 0 rows
from a non-empty table is a **failure**. Four of the six entities are scoped models, so before
ADR-0021 this job would have exported nothing for four of six and recorded success.

---

## 4. 10.3 — the backup is proven by restoring it

ADR-0024's claim, discharged with numbers.

| | |
|---|---|
| Plaintext dump | 386,308 bytes |
| Encrypted | 117,597 bytes, <1 s |
| Restore | 81/81 tables, **1,347/1,347 rows**, ~1 s |
| Schema | 26 triggers, 355 indexes, 73 CHECKs, 132 FKs, 53 enums, 50 functions — all identical |

Compared **table by table**: two tables wrong in opposite directions would net to the right total.

And the restored database *works* — ADR-0016's immutability triggers fire with their real messages
when an issued invoice is mutated or deleted. A restore with rows but no triggers passes a row count
and is still broken.

**A bug that would have failed every night:** `DATABASE_URL` carries `?schema=public`, which Prisma
requires and `pg_dump` rejects outright. Both scripts now strip Prisma-only params and keep real
libpq ones.

Public-key encryption, not a passphrase: the server holds only the public key and cannot read its
own backups. Guards exercised — checksum mismatch, non-empty target, and `hixaa_dms` refused
outright (confirmed still untouched at 39 tables).

---

## 5. 10.4 — a dead worker is now noticed

The control whose absence defined this phase.

| | |
|---|---|
| worker alive | `/health/worker` **200** |
| `kill -9` | `/health/worker` **503** |
| `/health/ready` | **200 throughout** |
| `/health/jobs` | `worker → seen 300s ago · stale=true` |

`/health/ready` staying green is deliberate: a dead worker must not pull the API out of service.

`track()` **wraps** each job rather than asking it to instrument itself — an instrumentation step
every job must remember is one some job will forget, and the forgotten one is invisible by
construction. That is precisely the mistake `withoutScope` made.

`lastSeenAt` and `lastSuccessAt` are separate columns because **a job failing every hour is very
much alive and completely broken**.

---

## 6. The scheduled report runner, and the leak it exposed

Reports run as their **owner**, never as SYSTEM — since ADR-0021 a SYSTEM principal reads unscoped,
which would compute a territory manager's report across every territory and then email it to them.

Writing `RequestContextStore.asUser()` exposed a hazard that applies to this codebase generally:

**Prisma operations are lazy.** `prisma.x.count()` builds a `PrismaPromise` that does not execute
until awaited. A helper written as `storage.run(ctx, fn)` exits the context the moment `fn` returns
an unresolved promise, so the scope extension's hook fires **outside** it, `applyScope` finds no
ambient context, and returns the query **unfiltered**:

```
asUser(p, () => prisma.distributor.count())        → 2   UNSCOPED
asUser(p, async () => prisma.distributor.count())  → 1   scoped
```

Same query, same user, different callback shape. `asUser` is now `async` and awaits inside
`storage.run`, so the shape cannot matter. `request-context.spec.ts` pins it with a deferred
thenable that captures the context at *resolution*. The same hazard exists for `asSystem` and is
harmless by luck there — losing the context yields the unscoped read it wanted anyway.

---

## 7. Verification assets

Re-run these rather than trusting this document.

| Script | Proves |
|---|---|
| `verify-worker-jobs.ts` | Every critical `@Cron` is registered; each job is run with and without the scope bypass and fails when they disagree |
| `verify-backup.ts` | Sheets export, masking, chunking, staging swap, restore diff, the zero-row guard — against either adapter |
| `verify-sheets-connection.ts` | Read-only Google reachability; separates bad credentials from an unshared spreadsheet (Google returns **403, not 404**) |
| `verify-db-backup.ts` | `pg_dump` → encrypt → restore → per-table row comparison |
| `verify-monitoring.ts` | That a dead worker would actually be noticed |
| `verify-scheduled-reports.ts` | Seeding, firing, owner scoping, permission refusal |

⚠️ All live under `src/scripts/` and run **compiled**. `tsx` cannot run Nest DI code: esbuild does
not implement `emitDecoratorMetadata`, so every constructor injection resolves to `undefined` and
presents as an application bug.

---

## 8. Deferred, with reasons

| Deferred | Why |
|---|---|
| **Point-in-time recovery** | No WAL archiving; up to 24h loss worst case. Needs continuous archiving to off-box storage — a Phase 11 decision with the VPS layout, not a thing to half-build |
| **Applying a Sheets restore** | Refused by design. Statutory tables reject writes by trigger (ADR-0016), the export redacts bank details so it cannot faithfully reconstruct a distributor, and `pg_dump` is the recovery path (ADR-0024) |
| **Sheets retry/backoff under real pressure** | The live runs never approached the quota, so it remains the least-tested code in the adapter. Said plainly in `docs/28` §7 |
| **MJML templates** | The renderer emits plain responsive HTML and works. Cosmetic |
| **XLSX / PDF report export** | Unchanged from Phase 9 — CSV works end to end |
| **Create/edit forms** | Unchanged. Still the largest frontend gap |
| **Log shipping / APM** | Phase 11, with the reverse proxy. Structured logs plus ops email is proportionate for one VPS |

---

## 9. What Phase 11 should know

- **A seed gap.** No account is both TERRITORY-scoped **and** holds `analytics:read:financial` —
  every catalogue report is financial, and the one territory-scoped account (`west.manager`) lacks
  it. So end-to-end *report* scoping is proven at the context level, not through a full scheduled
  run. Seed an account of that shape; HANDOFF §4.14 makes exactly this point.
- **Two `cron` versions briefly appeared.** `pnpm add cron` resolved `^4.4.0` when the tree already
  had 3.5.0 via `@nestjs/schedule`. Pinned to 3.5.0. Check the resolved version when adding a
  package that is already a transitive dependency.
- **`pnpm build` races the dev watcher.** `deleteOutDir: true` wipes `dist` under a running process
  and produces incoherent behaviour that looks like an application bug. Stop the preview first.
- **The `/api/v1` prefix excludes the health routes.** `live`, `ready`, `worker` and `jobs` are all
  served unprefixed so a monitor needs one base path.
- **`MAIL_OPS_TO` is still unset** in this environment, so every ops alert is recorded
  `UNDELIVERABLE` rather than delivered. That is now visible in `email_log` instead of silent — but
  nothing is actually being emailed. Setting it is a config change, no code.
- **E1 remains open.** Real GSTIN/PAN/CIN. Invoicing still refuses to ISSUE while
  `company.statutory.verified` is false.
