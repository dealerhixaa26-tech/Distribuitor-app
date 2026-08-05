# 26 — Phase 9 Completion: Intelligence

> Design: `25-phase-9-design.md`. ADRs **0019**, **0020**. Migration **0013**.
> `pnpm verify` green. `scripts/phase-9-smoke.sh` — 24 checks, all passing.

---

## 1. What now exists

Eight phases recorded facts. This one reads them: a live dashboard, per-panel
analytics, a six-report catalogue with CSV export, cross-entity search, and
notifications driven by events the outbox has been publishing since Phase 1.

| | |
|---|---|
| Models added | `ReportDefinition`, `ReportRun`, `SalesTarget` |
| Endpoints | 24 new |
| Tests | 368, up from 346 |
| Migrations | 0013 (models, indexes, constraints) · 0014 (removes two indexes that did not pay — §4a) |

## 2. Module 9.3 was measured, then deleted

`docs/08` §10 and roadmap 9.3 promised materialised views with a concurrent-refresh worker. Both
were written in Phase 0, before a row existed. Phase 9 wrote the aggregates and timed them first.

| Dashboard panel | 3-year projection | 10× that | + index |
|---|---|---|---|
| Revenue KPI | 0.5 ms | 1.0 ms | 0.5 ms |
| Outstanding + aging | 2.4 ms | 19.9 ms | **9.9 ms** |
| Sales trend, 12 months | 13.5 ms | 53.3 ms | **39.6 ms** |
| Top 10 products | 7.5 ms | 32.1 ms | 39.1 ms |
| Revenue by territory | 1.2 ms | 2.6 ms | 2.7 ms |
| Stock valuation | 2.6 ms | 2.2 ms | 1.8 ms |
| Top 10 distributors | 1.2 ms | 16.2 ms | **14.2 ms** |
| **Whole dashboard, serial** | **~29 ms** | **~127 ms** | **~108 ms** |

At ten times a generous three-year projection — 30,000 orders, 120,000 order lines — the entire
dashboard aggregates in ~108 ms behind a cache that absorbs nearly every load.

**Materialised views were dropped.** They would have bought ~100 ms on a minority of requests and
cost a staleness window that makes a KPI card disagree with the list it links to, a refresh worker
to monitor on a single VPS, and a raw-SQL view layer Prisma periodically proposes dropping
(HANDOFF §4.13). ADR-0019 carries the full reasoning and the concrete conditions for revisiting.
`docs/08` §10 and `docs/05` 9.3 now point at it rather than misleading the next reader.

**This reverses a recommendation made by the same process that wrote it.** The Phase 0 document was
not wrong to specify a plan; it was wrong to stay settled once there was data to test it against.

The smoke suite asserts what the trade bought: `receivables total == outstanding report total`. A
number that disagrees with its own drill-through is precisely what was traded away.

## 3. A pre-existing bug found by execution: the worker has not booted since Phase 6

While starting the worker to test the notifications processor, it died at boot:

```
UnknownDependenciesException: Nest can't resolve dependencies of the
DistributorsService (…, ?, …). EncryptionService at index [4] is not available
in the DistributorsModule module.
```

`InventoryModule` has imported `DistributorsModule` since Phase 6, and `DistributorsService` takes
`EncryptionService`. That service is exported by `AuthModule`, which is `@Global` — but **@Global
registers a provider only in a composition that imports the module at least once**, and
`worker.module.ts` never imported it. `git diff` confirms `InventoryModule` was in the worker's
imports before Phase 9 touched the file.

**Nothing noticed, because the API boots independently and the worker's only symptom is work
silently not happening.** The consequence is larger than it first appears: **the outbox dispatcher
runs in the worker**, so no domain event has ever actually been dispatched. `docs/HANDOFF` §8
recorded "the quotation email is not delivered" and attributed it to a missing PDF handler — the
handler was only half the reason.

Fixed by importing `AuthModule` into the worker. Safe despite its controller: the worker bootstraps
with `NestFactory.createApplicationContext`, which ignores controllers because there is no HTTP
adapter to bind them to.

On the first successful boot, **47 outbox events accumulated since Phase 6 dispatched at once**,
producing 65 notifications.

> Providing `EncryptionService` at the worker's own root was tried first and does not work: Nest
> resolves a service's dependencies in **its own module's** context, so the provider has to reach
> `DistributorsModule`. That is what `@Global` does and why the import is the fix.

## 4a. Two of my own indexes did not earn their place

Migration 0013 added a partial index on `order` plus covering indexes on `order_line` and
`invoice_line`. The partial one was measured and pays: receivables 19.9 ms → 9.9 ms. The covering
ones were added on the reasoning that they "help somewhat and cost one index" — which is not a
measurement, and is exactly the habit ADR-0019 was written against.

Measured properly, with only the partial index in place: sales trend **37.3 ms** (versus 39.6 ms
*with* the covering indexes) and top products **40.9 ms** (versus 39.1 ms). Identical within noise,
and one panel was slower with them.

They also could not be modelled by Prisma, so `migrate diff` proposed dropping them on every run
(HANDOFF §4.13) — caught by the drift check before commit. **Migration 0014 removes them.** The ADR
now records the corrected numbers.

## 4b. A second gap: `payment:delete` was held by no business role

The write-off approval chain (§5) is guarded by `PERMISSIONS.PAYMENT_DELETE`. Exercising it revealed
that permission was assigned to **SUPER_ADMIN and ADMIN only** — no business role held it.

That made writing off bad debt a system-administration task, and with a single admin account it was
impossible above the approval threshold: the requester needed a *different* authorised approver, and
there was none. Deciding what the company will not collect is a Finance Manager's job.

`FINANCE_MANAGER` now holds it. Found by trying to use the control rather than by reading the seed.

## 5. The two Phase 8 obligations, discharged

| Obligation | How, and how it was proven |
|---|---|
| **Stock valuation must EXCLUDE `DISTRIBUTOR` warehouses** (ADR-0014 §4) | Enforced in `AnalyticsService.inventoryHealth()` and in the `STOCK_VALUATION` report. Proven against real data: ₹16,80,000 owned (one COMPANY warehouse) and ₹3,36,000 channel, reported under separate keys and never summed. The report labels a channel row `(CHANNEL — not an owned asset)`, and there is deliberately **no parameter** that would merge the two |
| **Write-off approval chain** | Four cases proven end to end: below the ₹10,000 threshold succeeds with no approver; above it with no approver is refused; above it with the approver *equal to the requester* is refused with `SELF_APPROVAL_FORBIDDEN`; above it with a different authorised approver succeeds and records the approver in the ledger narration. The threshold is a setting, because "how much may one person forgive" is commercial policy |

## 6. Design decisions worth knowing

**Money is absent, never zero.** `analytics:read` returns operational counts; revenue and
receivables need `analytics:read:financial`. Without it the fields are omitted entirely — a zero is
a claim about the business, and "we made nothing" reads very differently from "you may not see
this". `/analytics/receivables` refuses outright rather than returning an empty report, because
`{}` would reasonably be read as "nothing is owed".

**The comparison period is the same LENGTH, not the previous calendar one.** On the 3rd of the
month, MTD compares three days against the previous month's first three. Comparing against a whole
month would report a ~90% collapse in revenue every month on the 1st, 2nd and 3rd — and a metric
that lies predictably is one nobody reads on the 4th either.

**`deltaPercent` is null when the baseline is zero.** Reporting "+100%" for a rise from nothing is a
lie people act on: ₹0 to ₹5,000 is a start, not a doubling.

**Target status is judged against elapsed time.** 40% of an annual target in April is not "behind".
A status computed from `achieved / target` alone marks every target BEHIND until December.

**Reports are a catalogue, not a builder** (ADR-0020). Six types with Zod-validated parameters; no
user input becomes SQL, which is what lets every report read through `prisma.db` and inherit the
scope extension rather than needing a DSL that injects scope predicates into shapes nobody
anticipated.

**Notifications are polled, not SSE — stated, not quietly skipped.** `docs/08` specifies an SSE
stream. That is a Phase 11 decision to take alongside the reverse-proxy configuration: SSE needs a
long-lived connection per user through Nginx with `proxy_buffering off`, heartbeats and reconnect
handling, to deliver something whose value decays over minutes. One indexed count per 30 seconds has
no failure mode worse than updating late (docs/25 §7).

## 7. Verification

`scripts/phase-9-smoke.sh` — **24 checks, all passing**, in the repo so Phase 10 can re-run it
rather than trusting this document. It covers all eight analytics panels, the financial gate in both
directions, both Phase 8 obligations, the dashboard/Outstanding reconciliation, the report
catalogue's refusals, search scoping and typo tolerance, and notifications.

Beyond the script: every KPI reconciled against hand-written SQL (revenue ₹12,88,560 and outstanding
₹2,97,360 both matched exactly); search scoping confirmed at the row level (3 invoices for admin,
2 for a West-scoped user, the Tamil Nadu one absent); all six reports run; CSV export carries a BOM
so Excel reads UTF-8; notification read is idempotent.

`pnpm verify` green: lint, typecheck, 368 tests, build.

## 8. Deferred, with reasons

| Deferred | Why |
|---|---|
| **SSE notification stream** | §6. A Phase 11 decision, taken with the reverse proxy rather than guessed now |
| **Materialised views** | ADR-0019, with measured numbers and explicit revisit conditions |
| **Scheduled report execution** | The schedule is stored, validated, and constraint-guarded (an active schedule with no recipients is refused). The cron *runner* is not wired — it belongs with the worker's other `@Cron` jobs, and the worker has only just been able to boot. Phase 10 |
| **XLSX and PDF report export** | CSV works end to end. The other two formats are accepted by the DTO and not yet rendered; the numbers are what a CA reads |
| **Create/edit forms** | Unchanged from every prior phase. Reports get a full run/download surface because a report you cannot run is not a report |
| **Chart rendering in PDF** | pdfmake draws vector primitives but has no chart layer |
| **Forecasting** | Three years of data is not enough to project from honestly, and a confident-looking wrong forecast is worse than none |

## 9. What Phase 10 should know

- **The worker now boots.** Everything that depends on it — the outbox dispatcher, the email
  processor, the quotation-email handler noted in HANDOFF §8 — should be re-examined, because none
  of it has ever actually run.
- **Scheduled reports need a cron runner** in the worker, following the `@Cron` pattern
  `MaintenanceProcessor` and `InventoryProcessor` already use.
- **No obligations are placed on Phase 10 beyond those two.** Both Phase 8 obligations are
  discharged and proven.
