# 27 — Phase 10 design: Integrations & Operations

> Written before the code, per `docs/HANDOFF.md` §9. Records what Phase 10 will build and why,
> including the parts that were found to be broken before any of it could be built on.

---

## 1. What Phase 10 walked into

Phase 9 fixed the worker's boot (`worker.module.ts` never imported `AuthModule`) and handed Phase 10
an instruction: **re-verify everything worker-resident, because none of it had ever run.** That
verification came first, and it found more than a dead process.

| # | Finding | Status |
|---|---|---|
| **A** | `pnpm dev` never started the worker at all — `turbo.json` had no `dev:worker` task, so no aggregate command invoked it. HANDOFF §3 and §4.23 documented a workflow that could not work | ✅ Fixed |
| **B** | Every background job read an **empty database**. `asSystem()` produces a context with no `access`, which `applyScope()` treated as an unauthenticated request and scoped to `id IN ()` | ✅ Fixed — ADR-0021 |
| **C** | Six event types reach the email queue and evaporate; the low-stock notification key does not match its constant; an ops alert leaves no record when the channel is unconfigured | ⬅ **This phase, §2** |

Finding B is the one that shapes this document. Three cron jobs — reconciliation, reservation
expiry, low-stock — ran nightly, read nothing, and reported success. ADR-0002's drift alarm was
structurally incapable of firing. The first run after the fix raised two genuine suppressed alerts
(`HTPL-RAKSHA-TAG` at 0 against a reorder level of 100).

**The lesson Phase 10 is designed around:** the danger in this system is not failure, it is
*success computed over an empty set*. A backup that exports zero rows and records a successful sync
is worse than one that crashes, because it manufactures confidence. Every deliverable below is
designed so that "it worked" and "it did something" cannot be confused.

That is not hypothetical for 10.1: four of the six backup entities — Distributors, Orders, Payments,
Inventory — are scoped models. Before ADR-0021, the Sheets backup would have exported nothing for
four of six and reported success.

---

## 2. Finding C — the event plumbing

Proven by injecting one event of each type through the real outbox and reading the worker's own log.
Ten events in, one email and eight notifications out.

### 2.1 What is broken

| Event | Routed to | What happens |
|---|---|---|
| `security.token_reuse_detected` | EMAIL | `sendOps` returns early — **no `EmailLog` row at all** |
| `quotation.sent` | EMAIL | no `case` — `default:`, debug log, gone |
| `invoice.issued` | EMAIL | no `case` |
| `distributor.approved` | EMAIL | no `case` |
| `inventory.reconciliation_drift` | EMAIL | no `case` |
| `inventory.stock_low` | NOTIFICATIONS | `describe()` matches `'stock.low'`; the constant is `'inventory.stock_low'` |
| `payment.verified` | *(unrouted)* | handler exists in `describe()`, never reachable |

`EVENT_QUEUE_ROUTING` carries the comment *"Exhaustive by construction."* It is
`Readonly<Record<string, QueueName>>` — a plain string-keyed record with no exhaustiveness check
whatsoever. The comment is false, and its falseness is precisely what let seven gaps accumulate
across four phases without anyone noticing.

### 2.1b A third copy, found while fixing the second

Fixing `describe()` did **not** make low-stock notifications work. Re-running the injection showed
`inventory.stock_low` still producing zero, and the reason was a *second, independent* copy of the
same typo one function away: `EVENT_AUDIENCE` in `notifications.service.ts` — which maps an event to
the permission that defines its recipients — was also keyed by literal, and also said `'stock.low'`.

It carried a second one too: `'distributor.catalog.changed'`, dots where the constant has an
underscore. That is why the two `distributor.catalog_changed` events in the outbox produced nothing.

So an event had to clear **three** hand-keyed tables to reach a person, two of them keyed by
literal, and nothing checked that they agreed. Fixing any one alone changed nothing observable,
which is exactly why the bug survived: each fix would have looked like it had failed.

This is recorded because it changes the conclusion. The rule is not "fix the `stock.low` typo" but
**no string literal may key any table on the event path** — and the three tables must be made to
prove they agree, in a test. `event-plumbing.spec.ts` does that, asserting for every
notifications-routed event that a message exists and an audience is mapped. Reintroducing the
original typo now fails to **compile**, so the test suite cannot even run.

### 2.2 Decisions

**A consumer never matches an event by string literal.** Every `case` becomes
`DOMAIN_EVENTS.X`. The `'stock.low'` bug is not a typo to fix once; it is the failure mode of
matching on literals, and it will recur while literals are permitted.

**The routing table becomes exhaustive for real.** Typed as
`Record<DomainEvent, QueueName | null>`, where `null` is an explicit statement that an event has no
consumer. Adding an event to `DOMAIN_EVENTS` then fails to compile until someone decides where it
goes. `null` is deliberately not the same as "absent": absent is an oversight, `null` is a decision.

**A routed event with no handler is an error, not a debug line.** Today `default:` logs at debug and
returns. It becomes a warning that names the event and raises an ops alert on first occurrence —
because "this event is routed to me and I do not know what to do with it" is a wiring bug, and it
has been silently true seven times.

### 2.3 Which handler each event gets

| Event | Channel | Why |
|---|---|---|
| `quotation.sent` | BUSINESS + PDF | The gap HANDOFF §8 records. `GET /quotations/:id/pdf` already renders; the handler attaches it |
| `invoice.issued` | BUSINESS + PDF | Same shape, reusing `DocumentRendererService` |
| `distributor.approved` | BUSINESS | A partner being approved is news for the partner |
| `report.ready` | BUSINESS | Scheduled reports reach partners — §7 |
| `inventory.reconciliation_drift` | **OPS** | Ledger and balances disagreeing is an operator emergency, not partner news |
| `payment.verified`, `invoice.overdue`, `order.rejected` | NOTIFICATIONS | Handlers already written; they only need routing |
| `inventory.stock_low` | NOTIFICATIONS | Fix the key |

---

## 3. 10.2 — The ops channel (built first)

10.2 comes **before** 10.1, inverting the roadmap's order, because 10.1's failure reporting depends
on it. A backup that alerts through a channel which silently discards alerts is not reporting.

### 3.1 The actual problem

`MailService.sendOps()` is written and correct. Seven ops templates exist and render:
`deploy-result`, `backup-report`, `health-alert`, `security-alert`, `queue-alert`,
`sheets-sync-failed`, `error-spike`. The type-level channel separation works — sending an ops
template to a distributor is a compile error, as designed.

What is missing is everything around it. `MAIL_OPS_TO`, `MAIL_OPS_USER` and `MAIL_OPS_FROM_ADDRESS`
are empty, so `sendOps` logs `MAIL_OPS_TO is not configured; ops alert not sent` and returns —
**before** the `EmailLog` row is written. Every ops alert in the system currently evaporates:
queue depth, dead letters, token reuse, health, backup.

### 3.2 Decision — an alert that cannot be delivered is still recorded

An undeliverable alert must not become a silent no-op. `sendOps` will write its `EmailLog` row
**first**, with status `UNDELIVERABLE` and a reason, then attempt delivery. The record of *what the
system tried to tell you* survives the channel being misconfigured.

This is ADR-0022. It matters more than it looks: the two mechanisms that hid the dead worker for
three phases were (1) nothing checked whether it was alive and (2) its silence was
indistinguishable from health. An alerting path that discards alerts when unconfigured rebuilds
exactly that.

Corollaries:
- Boot-time validation. If `MAIL_OPS_TO` is empty outside development, the process **refuses to
  start**, in the manner of the ClamAV and S3 drivers, which throw rather than degrading silently.
- In development both channels stay on `LogTransport` — no real mail from a dev machine
  (`docs/07` §1). ⚠️ Note the current `.env` points the business channel at `smtp.hostinger.com`
  with a real user; only an empty password saves it. The dev guard will key on `NODE_ENV`, not on
  whether credentials happen to be absent.
- `monitorQueues()` currently watches **one** of five queues. It will iterate all five, and the
  threshold moves from a hardcoded constant to configuration.

---

## 4. 10.1 — Google Sheets backup

**E7 is unanswered: there is no Google Cloud service account.** The owner chose to build against a
stub and receive a setup guide, as E1/E2 were handled in Phase 8.

### 4.1 The seam

```ts
export interface SheetsPort {
  ensureSheet(spreadsheetId: string, title: string): Promise<void>;
  replaceRows(spreadsheetId: string, title: string, rows: string[][]): Promise<void>;
  swapSheet(spreadsheetId: string, from: string, to: string): Promise<void>;
  readRows(spreadsheetId: string, title: string): Promise<string[][]>;
}
```

Two implementations: `GoogleSheetsAdapter` (written against the API, **unexecuted** until
credentials exist) and `LocalFileSheetsAdapter`, which writes the same tabular payloads to
`storage/sheets-backup/<spreadsheet>/<sheet>.csv` through the existing `StorageService`.

**The stub is a first-class citizen, not a mock** (ADR-0023). It is a real backup target that a
person can open, and it stays in the codebase permanently as the local-development driver — the same
posture as `LocalStorageDriver`. This is what makes ~85% of 10.1 shippable and verified now.

### 4.2 What ships done, and what waits for credentials

**Done, no rework:** `SyncJob` model and migration; the six entity extractors and their masking
rules; chunking and keyset-paginated checkpointing; the token-bucket limiter and backoff policy;
`POST /backup/sheets/sync` and `/restore`; permissions and DTOs; restore dry-run with a row-level
diff, confirmation token and audit entry; ops alerting; cron wiring.

**Needs rework when credentials arrive:** the service-account JWT flow; real `429`/`503` shapes (the
limiter is tuned blind); `values.batchUpdate` payloads and error codes; temp-sheet-then-swap, whose
semantics the stub can only emulate; the 10M-cell shard thresholds, untested against a real
spreadsheet.

⚠️ **`SyncJob` does not exist.** `docs/07` §2 refers to `SyncJob.checkpointCursor` and HANDOFF
lists it under "reuse, do not rebuild", but there is no such model among the 79 in `schema.prisma`
and no migration for it. It is new work, not reuse.

### 4.3 Safety properties

Carried from `docs/07` §2, with one addition.

- Worker-only. The API never calls the Sheets API.
- Chunked and checkpointed — a failure at row 400,000 resumes there.
- Quota-aware: `values.batchUpdate`, token bucket, backoff on `429`/`503`.
- Full replace per entity via a temporary sheet then a swap, so a failed run never leaves a
  half-written backup that looks complete.
- Sensitive fields excluded or masked — no password hashes, no refresh tokens, no decrypted bank
  numbers. A spreadsheet is a weaker boundary than the database.
- **New: a sync that exports zero rows for a non-empty table FAILS.** Not a warning — a failure.
  This is Finding B written into the deliverable: the exact accident that would have produced a
  silent empty backup is now the thing the job asserts against.

### 4.4 Restore

Dry-run by default, producing a row-level diff; requires `backup:restore`; needs an explicit
confirmation token; refuses to run against a non-empty table without an explicit force; writes a
full audit entry. Restores are rare and high-stakes and should feel that way.

### 4.5 Honest limitation, restated

Sheets caps at 10M cells per spreadsheet. At the stated scale a single spreadsheet cannot hold
everything, so the design shards by entity with an index sheet. **Sheets is a convenience backup for
human inspection. `pg_dump` (10.3) is the disaster-recovery mechanism.** Relying on Sheets to
recover a million-row database would be negligent.

---

## 5. 10.3 — Database backups

The real DR path, and the reason 10.1 is allowed to be a convenience.

- Nightly `pg_dump` (custom format, compressed), driven by a `@Cron` in the worker.
- **Encrypted at rest** with an age/GPG recipient key. The decryption key must not live only on the
  box being backed up, or the backup and the thing it protects share a failure.
- **Off-box copy** through the existing `StorageService` seam, so local-disk today and S3-compatible
  object storage later is a driver swap, not a rewrite.
- Retention: daily for 14 days, weekly for 8 weeks, monthly for 12 months.
- Reports to the ops channel via the existing `backup-report` template, which already carries
  `status | target | sizeBytes | durationSeconds | error`.

### Decision — a backup is proven by restoring it (ADR-0024)

A `pg_dump` that exits 0 proves the command ran, not that the output can be restored. `scripts/`
gets `backup.sh` and `restore.sh`, and the restore is **rehearsed against a scratch database as part
of this phase**, with the row counts recorded in the completion document. The roadmap says
"REHEARSED"; that word is the deliverable.

A monthly `@Cron` performs an automated restore rehearsal into a scratch database, compares table
counts against the source, and alerts on divergence — so the backup's *restorability* is monitored,
not just its existence.

---

## 6. 10.4 — Monitoring

The API already has `/health/live` and `/health/ready`, correctly split so a database blip cannot
trigger a restart loop.

### 6.1 The worker has no health surface at all

This is the gap that let a dead worker go unnoticed for three phases. Its only symptom was work
silently not happening, and §4.23's remedy — "boot both processes" — pointed at a command that did
not start it (Finding A).

The worker will maintain a **heartbeat**: a `SystemSetting` row (or dedicated table) holding
`workerLastSeenAt`, `workerBootedAt` and the process version, written every 30 seconds. Then:

- `GET /health/worker` on the API reports the worker's liveness from that heartbeat, so an external
  uptime check covers a process that serves no HTTP itself.
- `/health/ready` **does not** depend on it: a dead worker must not pull the API out of service.
- A stale heartbeat raises a `health-alert` to the ops channel.

A job that has not run for materially longer than its schedule is reported the same way — the
question "did the nightly reconciliation actually run last night?" must have an answer that is not
"grep the logs".

### 6.2 The rest

- **Slow-query reporting.** `PrismaService` already logs above `DATABASE_SLOW_QUERY_MS`. Phase 10
  aggregates the top offenders into a daily ops digest instead of leaving them to accumulate in a
  log nobody reads. (This is how the four-concurrent-workers contention was spotted.)
- **Error alerting.** An `error-spike` template already exists; it needs a counter and a threshold.
- **Uptime.** External checks hit `/health/live` and `/health/worker`; the runbook records what to
  do when each fails.

---

## 7. Scheduled report runner

Outstanding from Phase 9. `ReportDefinition` stores `cronExpression`, `recipients`,
`isScheduleActive`, `lastRunAt`, `nextRunAt`, and a CHECK refuses an active schedule with no
recipients. Nothing executes it.

A single `@Cron` in the worker sweeps every minute for definitions whose `nextRunAt` has passed,
enqueues them onto the existing `reports` queue, and advances `nextRunAt`. One sweeping scheduler
rather than dynamically registering a `CronJob` per definition: definitions are data and change at
runtime, and a registry that must be kept in sync with a table is a source of drift for no benefit
at this volume.

Reuses `ReportsService` and its CSV writer, `DocumentRendererService`, and the business mail
channel. Recipients are partners, so scheduled reports are BUSINESS, never OPS.

---

## 8. Sequencing

10.2 came first, for the reason in §3: a backup that reports failures through a channel which
discards them is not reporting. With that done, the **remaining modules run in roadmap order** at
the owner's direction — 10.1, 10.3, 10.4 — which is now unblocked, because the only real dependency
between them was 10.1 needing somewhere to send a failure.

1. ✅ **§2 event plumbing** — the routing table and handlers, since everything downstream reports
   through it
2. ✅ **10.2 ops channel** — ADR-0022, so failures have somewhere to go
3. **10.1 Sheets backup** — against `LocalFileSheetsAdapter`, plus the GCP setup guide
4. **10.3 database backups** — including the rehearsed restore
5. **10.4 monitoring** — worker heartbeat, the control that would have caught the original bug
6. **§7 scheduled report runner**

One consequence worth stating: the worker heartbeat now lands *last* rather than first. Until it
does, a dead worker is still detectable only by its silence — the condition that hid the original
three-phase failure. Nothing in 10.1 or 10.3 depends on it, so this costs nothing but the order in
which the safety net arrives.

## 9. Deferred, with reasons

| Deferred | Why |
|---|---|
| Live Google Sheets execution | No service account (E7). The adapter is written; only credentials gate it |
| MJML template compilation | `docs/07` §1 specifies MJML; the current renderer emits plain responsive HTML and works. Cosmetic, and not what makes an ops alert useful |
| SMS / WhatsApp channels | Post-v1 in the roadmap; `NotificationPreference` already carries the columns |
| e-Invoice / e-Way live calls | Unchanged — turnover does not require it |
| Log shipping / APM | Phase 11, alongside the reverse proxy. A single VPS with structured logs and ops email is proportionate now |
