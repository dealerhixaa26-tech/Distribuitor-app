# ADR-0019 — Aggregate on demand behind a short cache, not materialised views

- **Status:** Accepted
- **Date:** 2026-08-04
- **Reverses:** `docs/08-frontend-and-ux.md` §10, and roadmap item 9.3

## Context

`docs/08-frontend-and-ux.md` §10 was written in Phase 0, before a single row existed:

> Every panel reads a **materialised view** through a 5-minute Redis cache, and each is
> independently suspended so a slow panel never blocks the page.

The roadmap turned that into module **9.3 — Materialised views: pre-aggregation + concurrent
refresh worker.**

It was a reasonable guess. It was also a guess: nobody knew how much data Hixaa would have or how
expensive the aggregates would actually be. Building a refresh worker because a Phase 0 document
said so, without checking, is how systems acquire machinery nobody can later justify.

So the aggregates were written and measured before anything was decided.

## Measurement

A scratch database was loaded to two volumes and every dashboard panel timed with
`EXPLAIN (ANALYZE, BUFFERS)`.

**Volume A — three years, projected generously.** Hixaa is an RFQ-first projects business with
45–120 day lead times; 1,000 orders a year is optimistic, not conservative. 30 distributors,
150 customers, 300 products, 3,000 orders, 12,000 order lines, 2,572 invoices, 10,288 invoice
lines, 30,000 stock ledger rows.

**Volume B — ten times that.** 30,000 orders, 120,000 order lines, 29,572 invoices, spread over ten
years. This is not a forecast; it is the point of the exercise — a decision about pre-aggregation
should be tested against where the system could plausibly go, not only where it is.

| Dashboard panel | Volume A | Volume B | Volume B + index |
|---|---|---|---|
| Revenue KPI, month vs previous | 0.5 ms | 1.0 ms | 0.5 ms |
| Outstanding + aging, all parties | 2.4 ms | 19.9 ms | **9.9 ms** |
| Sales trend, 12 months | 13.5 ms | 53.3 ms | **39.6 ms** |
| Top 10 products by revenue | 7.5 ms | 32.1 ms | 39.1 ms |
| Revenue by territory | 1.2 ms | 2.6 ms | 2.7 ms |
| Stock valuation | 2.6 ms | 2.2 ms | 1.8 ms |
| Top 10 distributors | 1.2 ms | 16.2 ms | **14.2 ms** |
| **Whole dashboard, serial** | **~29 ms** | **~127 ms** | **~108 ms** |

The two panels that resist indexing (sales trend, top products) do so for a legible reason: they
genuinely have to aggregate 120,000 line rows, and no index removes that work. Everything else
responds to a targeted index.

## Decision

**Aggregate on demand. No materialised views, and no refresh worker.**

### 1. What replaces module 9.3

- **One targeted index**: a PARTIAL index on `order (order_date, type, status)` excluding dead
  statuses. It took the receivables panel from 19.9 ms to 9.9 ms, and being partial it also escapes
  Prisma's drop-proposal (HANDOFF §4.13).

  Covering indexes on `order_line` and `invoice_line` were added first and then **removed in
  migration 0014**, because measuring them properly showed they paid nothing: sales trend 39.6 ms
  with versus 37.3 ms without, and top-products was actually *slower* with them (39.1 vs 40.9 ms).
  Those two panels aggregate 120,000 line rows and no index removes that work. They also could not
  be modelled by Prisma, so they drifted on every `migrate diff`. This ADR's own rule, applied to
  itself: an index nobody measured is a write cost nobody accounted for.
- **The 5-minute Redis cache stays.** That part of `docs/08` §10 was right and is cheap: the p99
  dashboard load is a cache read, and the uncached path is ~108 ms at ten times plausible volume.
- **Per-panel endpoints**, so the frontend can suspend each independently — also as `docs/08`
  specified, and unaffected by this decision.

### 2. Why materialised views lose, given those numbers

**They buy roughly 100 ms.** Against a 5-minute cache that already absorbs nearly every load, the
win lands on a small minority of requests and is imperceptible on any of them.

**They cost correctness.** A materialised view is stale by its refresh interval. `docs/08` §10 also
says *"every card links through to the filtered list that produced it"* — so a stale KPI card sends
the user to a list that disagrees with it. A number that does not reconcile with the screen behind
it is worse than a slow number, because the user stops trusting the whole dashboard rather than
that one panel.

**They cost operations.** `REFRESH MATERIALIZED VIEW CONCURRENTLY` needs a unique index on every
view, a worker, failure handling, and monitoring for a refresh that silently stopped. On a single
VPS running API, worker, Postgres and Redis together, a periodic full re-aggregation is also the
largest recurring load the box would carry — spent to save 100 ms on a cached page.

**They fight the ORM.** Prisma cannot model a materialised view, so every read becomes raw SQL —
and per HANDOFF §4.13, `migrate dev` proposes DROPPING database objects the schema does not know
about. Phase 4's search indexes were nearly lost to exactly that. A view layer would need the same
care, permanently.

### 3. When this should be revisited

Concretely, so nobody has to re-derive the judgement:

- **A single panel exceeds ~200 ms at real volume.** That is roughly 5× Volume B's worst case, and
  the point at which the cache miss becomes visible rather than merely measurable.
- **Or the cache hit rate falls below ~80%**, meaning users are hitting cold aggregates often enough
  for the uncached path to be the common one.

The fix at that point is a **targeted rollup table for the one panel that hurts** — most likely a
daily sales rollup, maintained by the same outbox the rest of the system already uses — not a
wholesale materialised-view layer. Adding one narrow rollup later is easy; removing a refresh
worker that turned out to be unnecessary is the thing nobody ever gets round to.

## Consequences

**Good.** Every figure on the dashboard is computed from live tables at the moment it is asked for,
so a KPI card and the list it links to cannot disagree. No refresh worker to monitor, no staleness
window to explain, no unique-index requirement, no raw-SQL view layer for Prisma to threaten. The
5-minute cache still means most loads never touch the database.

**Costs.** The uncached dashboard is ~108 ms of database work at ten times plausible volume rather
than ~10 ms. Two panels will grow roughly linearly with order-line count and will be the first to
need attention. Anyone reading `docs/08` §10 or roadmap 9.3 without this ADR will expect
machinery that does not exist — which is why both now point here.

**Honest note.** This reverses a recommendation made in Phase 0 by the same process that wrote it.
The earlier document was not wrong to specify a plan; it was wrong to be treated as settled once
data existed to test it against.
