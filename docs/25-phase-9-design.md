# 25 — Phase 9 Design: Intelligence

> Gate 1 (Design) for Phase 9. Written before any application code, and after
> **measuring** rather than assuming — see §3.
> New ADRs: **0019** (aggregate on demand, no materialised views — reverses a Phase 0 assumption),
> **0020** (reports are a catalogue, not a query builder).
> Completion record: `26-phase-9-completion.md`.

---

## 1. What this phase actually is

Phases 1–8 recorded things. Phase 9 is the first phase that only *reads* them.

```
catalog · inventory · sales · finance          ← eight phases of recorded facts
                    ↓
      analytics · reports · notifications · search      ← Phase 9 reads, never writes
                    ↓
        "how is the business doing, and who should I call"
```

That inversion sets the phase's one rule: **nothing here may change a business fact.** The two
exceptions are deliberate and small — `Notification` rows, and `ReportDefinition` / `ReportRun`
records of what someone asked for. Neither is a business fact; both are records *about* the system.

A reporting layer that can write is how a "fix the number in the report" request eventually becomes
a UPDATE against a ledger.

## 2. Scope

| # | Module | What lands |
|---|---|---|
| 9.1 | Dashboard | KPI cards with period-over-period deltas, sales trend, revenue by territory, top products and distributors, inventory health, recent activity |
| 9.2 | Analytics | Distributor, product and regional performance; target vs achievement |
| 9.3 | ~~Materialised views~~ | **Replaced by ADR-0019** — targeted indexes + the 5-minute Redis cache. See §3 |
| 9.4 | Reports | Six-entry catalogue, saved definitions, CSV/XLSX/PDF export through the existing `REPORTS` queue |
| 9.5 | Scheduled reports | Cron definitions, emailed on the business channel |
| 9.6 | Notifications | Outbox-driven, preferences, unread count, in-app list |
| 9.7 | Global search | Cross-entity Postgres FTS, scoped, with a ⌘K palette |

Plus the two obligations Phase 8 placed here (§8).

## 3. Module 9.3 was measured, and then deleted

`docs/08` §10 and roadmap 9.3 both promised materialised views with a concurrent-refresh worker.
Both were written in Phase 0, before any data existed.

The aggregates were written and timed first. At **ten times** a generous three-year projection —
30,000 orders, 120,000 order lines — the entire dashboard aggregates in **~108 ms**, and the two
panels that resist indexing do so because they genuinely must touch 120,000 line rows.

Against a 5-minute cache that absorbs nearly every load, materialised views buy ~100 ms on a
minority of requests, and cost: a staleness window that makes a KPI card disagree with the list it
links to; a refresh worker to monitor on a single VPS; and a raw-SQL view layer that Prisma will
periodically propose dropping (HANDOFF §4.13).

**Decision: aggregate on demand behind the cache.** Full reasoning, the measurement table, and the
concrete conditions for revisiting are in **ADR-0019**. `docs/08` §10 and `docs/05` 9.3 now point
there.

## 4. Schema — migration 0013

Small, because this phase mostly reads.

| Model | Purpose |
|---|---|
| **`ReportDefinition`** | A saved, named instance of a catalogue report type plus its validated parameters (ADR-0020) |
| **`ReportRun`** | One execution: status, row count, the produced `Document`, and who asked |
| **`SalesTarget`** | Period targets by territory / distributor / product, so "target vs achievement" has a target to compare against |
| `Notification` | **Exists** since Phase 1, schema only. Phase 9 writes to it for the first time |
| `NotificationPreference` | **Exists**. Phase 9 reads it to decide channels |

### Indexes, from the measurement

Two, both justified by §3's numbers rather than by intuition:

- `order (order_date, type, status)` **partial**, excluding `DRAFT`/`CANCELLED`/`REJECTED` — took
  the aging panel from 19.9 ms to 9.9 ms. Partial also keeps it out of Prisma's drop proposals.
- `order_line (order_id) INCLUDE (line_total, quantity, product_id)` — a covering index for the
  line aggregates.

Indexes that measurement did *not* justify were not added. An index nobody measured is a write cost
nobody accounted for.

## 5. Analytics — the shape

Per-panel endpoints under `/analytics`, each independently cacheable and independently suspendable
by the frontend (`docs/08` §10):

```
GET /analytics/kpis?period=MTD          revenue, orders, outstanding, low-stock — each with a delta
GET /analytics/sales-trend?months=12    monthly series
GET /analytics/by-territory?months=12
GET /analytics/top-products?limit=10
GET /analytics/top-distributors?limit=10
GET /analytics/inventory-health         stock value, low-stock, dead stock, ageing inventory
GET /analytics/receivables              aging summary — delegates to OutstandingService
GET /analytics/targets?period=          target vs achievement
GET /analytics/activity?limit=20        recent cross-entity events
```

### Three rules these share

**1. Every panel reuses the service that owns the number.** Receivables aging comes from
`OutstandingService`, not a second aggregate that could disagree with the Outstanding screen. The
same applies to `LedgerService` for balances. A dashboard that computes its own version of a number
the system already knows is how two screens come to show different figures.

**2. `analytics:read:financial` gates money.** `analytics:read` alone returns operational counts —
orders, stock, activity — with revenue and receivables omitted rather than zeroed. A zero is a
claim; an absent field is an absent permission.

**3. Everything is scoped.** These are aggregates over scoped models read through `prisma.db`, so a
territory-scoped manager's dashboard sums their subtree. The aggregate paths that need raw SQL take
the resolved scope as a **parameterised** id list — never interpolated (ADR-0020 §2).

### Period-over-period deltas

Every KPI carries `{ value, previousValue, deltaPercent, direction }`. The comparison period is the
**same length immediately before** the current one — MTD compares against the same day-count of the
previous month, not the whole of it, so on the 3rd of the month the card is not comparing three days
against thirty and reporting a collapse.

## 6. Reports

Six catalogue entries (ADR-0020): `SALES_SUMMARY`, `DISTRIBUTOR_PERFORMANCE`,
`PRODUCT_PERFORMANCE`, `STOCK_VALUATION`, `RECEIVABLES_AGING`, `GST_SUMMARY`.

```
GET    /reports/catalogue          the types, their parameters, and their columns
GET    /reports                    saved definitions
POST   /reports                    save a configured definition
POST   /reports/:id/run            execute — inline under the row cap, queued above it
GET    /reports/runs/:id           status and the produced document
GET    /reports/runs/:id/download
POST   /reports/:id/schedule       cron + recipients
```

**Execution is synchronous under a row cap and queued above it** — a 500-row report should not
require a job, a poll and an email. `GST_SUMMARY` delegates to `GstReturnsService`; it is a
presentation of the same figures the return carries, and computing them twice is how a report and a
filing come to disagree.

Scheduled runs use the same `@Cron` + BullMQ pattern the maintenance and inventory processors
already use, and email on the **business** channel (`MailChannel.BUSINESS`), which is the transport
that reaches distributors and customers.

## 7. Notifications and search

### Notifications are outbox-driven

`Notification` rows are written by a processor consuming the events the outbox already emits —
`order.approved`, `invoice.issued`, `invoice.overdue`, `payment.recorded`, and the low-stock signal
Phase 6 already produces. Nothing new needs to emit anything: **ADR-0005 put every side effect
through the outbox precisely so a later phase could add a consumer without touching a producer.**

Delivery is **in-app plus email**, read through a polled unread count.

> **Deviation from `docs/08`, stated rather than quietly taken.** That document specifies an SSE
> stream. SSE holds one long-lived connection per signed-in user through Nginx on a single VPS,
> needs `proxy_buffering off` and heartbeats to survive idle timeouts, and reconnect handling on the
> client — to deliver a notification whose value decays over minutes, not seconds, to a handful of
> users. A 30-second poll on the unread count is one indexed query per user per half-minute and has
> no failure mode more interesting than "the number updates late". SSE is a Phase 11 decision to
> take alongside the reverse-proxy configuration, not a Phase 9 one to take blind.

### Global search

One endpoint, `GET /search?q=`, across invoices, orders, quotations, distributors, customers and
products.

Products already have a `search_vector` with a GIN index and `word_similarity` fallback (Phase 4,
HANDOFF §4.11). The other entities are searched by their identifying columns — number, code, name,
GSTIN — with `word_similarity` for typo tolerance, because HANDOFF §4.11 records that plain `%`
compares whole strings and silently finds nothing on a long name.

**Results are scoped**, so search cannot become the enumeration oracle that `NotFoundError`'s 404
was chosen to avoid. Each group is capped and the palette shows the top few per entity, because a
command palette is for jumping to a known thing, not for browsing.

## 8. The two obligations from Phase 8

| Obligation | How it lands |
|---|---|
| **Stock valuation must EXCLUDE `DISTRIBUTOR` warehouses** (ADR-0014 §4) | Enforced in `AnalyticsService.inventoryHealth()` and in the `STOCK_VALUATION` report, and asserted in a unit test that fails if the filter is dropped. Those goods are sold; counting them overstates assets. The channel figure is reported **separately and labelled**, because "what our partners hold" is a real question — just not an asset |
| **Write-off approval chain** | `LedgerService.writeOff()` exists and posts immediately. Phase 9 puts an approval in front: a write-off above a configurable threshold requires a second approver who is not the requester — the same `SelfApprovalError` control as order approval and payment verification |

## 9. Verification plan

Typecheck proves nothing here either. The gate is real data and real HTTP.

1. Seed the benchmark volume into a scratch database; confirm every panel returns and the numbers
   reconcile against hand-written SQL.
2. **Cross-check the dashboard against the screens it links to.** Receivables total must equal the
   Outstanding page; GST summary must equal `GET /gst/gstr1`. A number that disagrees with its own
   drill-through is the specific failure ADR-0019 traded materialised views away to prevent.
3. Stock valuation **excludes** distributor warehouses — proven by seeding channel stock and showing
   it is absent from the asset figure and present in the channel figure.
4. As `west.manager@hixaa.test` (territory-scoped), every analytics panel returns **only** the West
   subtree, and global search returns no out-of-zone row.
5. A report runs inline under the cap and queues above it; the queued run produces a downloadable
   document.
6. A write-off above the threshold is **refused** without a second approver, and refused again when
   the approver is the requester.
7. `analytics:read` without `analytics:read:financial` omits money fields entirely.
8. `pnpm verify` green.

Steps 2, 3, 4, 6 and 7 are the ones that matter — four of the five are refusals or reconciliations.

## 10. Deferred, with reasons

| Deferred | Why |
|---|---|
| **SSE notification stream** | §7. A Phase 11 decision, taken with the reverse-proxy configuration rather than guessed now |
| **Materialised views** | ADR-0019, with measured numbers and explicit revisit conditions |
| **Create/edit forms** | Unchanged from every prior phase — the UI is read-only and mutations are curl-verified. Reports get a run/download surface because a report you cannot run is not a report |
| **Chart rendering in PDF reports** | Tabular export only. pdfmake draws vector primitives but has no chart layer; a chart in a PDF is a Phase 11 nicety, and the numbers are what a CA and an owner actually read |
| **Forecasting / trend projection** | Three years of data is not enough to project from honestly, and a confident-looking wrong forecast is worse than none |
| **Custom dashboard layouts per user** | One good default beats a layout engine nobody rearranges |
