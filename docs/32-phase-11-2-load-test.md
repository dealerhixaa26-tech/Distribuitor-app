# 32 — Phase 11.2: load test at roadmap volume

> Measured, not estimated. Every number below is a **p95 over 7–11 runs** with the first discarded
> as warm-up, against a real 2.5 GB database.

---

## 1. Volume under test

| Table | Rows |
|---|---|
| `distributor` | 100,000 |
| `product` | 1,000,019 |
| `order` | 500,000 |
| `order_line` | **5,000,000** |
| Database size | 2,495 MB |

Exactly what roadmap 11.2 specifies. Seeded by `scripts/load-seed.sql` into a scratch database
(`hixaa_dms_load`); `hixaa_dms_dev` was not touched.

> ⚠️ **Read this as a stress test, not a projection.** ADR-0019 established that a generous
> three-year projection for this business is 30 distributors, 300 products and 12,000 order lines —
> Hixaa is an RFQ-first projects business where "1,000 orders a year is optimistic". The roadmap's
> 11.2 numbers are **417× that on order lines and 3,333× on distributors**. They were written in
> Phase 0 before anyone knew the business. The test is still worth running — it finds the breaking
> point — but a breach here is not a live problem.

---

## 2. Results

### Dashboard panels — ADR-0019 revisits above 200 ms

| Panel | p95 | vs 200 ms |
|---|---|---|
| Revenue KPI, month | **7.1 ms** | ✅ |
| Sales trend, 12 months | **30.1 ms** | ✅ |
| **Top 10 products** (aggregates 5M lines) | **2,327.5 ms** | ❌ **11.6× over** |
| Top 10 distributors | **148.3 ms** | ✅ (closest passing) |
| Revenue by territory | **36.9 ms** | ✅ |

### List endpoints — `docs/00` target p95 < 300 ms

| Endpoint | p95 | Verdict |
|---|---|---|
| Distributors, page 1 | **3.0 ms** | ✅ |
| Products, page 1 (1M rows) | **134.7 ms** | ✅ |
| Orders, page 1 | **3.0 ms** | ✅ |
| Distributors scoped to one territory | **6.3 ms** | ✅ — the RBAC predicate costs ~3 ms at 100k rows |

### Search and pagination

| Query | p95 | Verdict |
|---|---|---|
| Fuzzy search — **function form (before)** | **1,212.2 ms** | ❌ |
| Fuzzy search — **operator form (after)** | **5.7 ms** | ✅ **213× faster** |
| Deep offset 500k | **279.3 ms** | ⚠️ passes, barely — see §5 |

---

## 3. The finding: 69 MB of trigram index that nothing read

`ProductsService.searchIds()` filtered with the **function** form:

```sql
WHERE GREATEST(word_similarity(term, name), word_similarity(term, sku)) > 0.4
```

That form **cannot use a GIN trigram index.** Confirmed by plan — `Parallel Seq Scan on product`,
scanning 1M rows to return 6.

Meanwhile `product_name_trgm_idx` (37 MB) and `product_sku_trgm_idx` (32 MB) existed, were
maintained on every product write, and had `idx_scan = 0` from the application. They are a
substantial part of why bulk-inserting 1M products was slow.

This is ADR-0019's own rule pointed at Phase 4: *"an index nobody measured is a write cost nobody
accounted for."*

**In fairness to the original decision**, the code said the seq scan was deliberate — the fuzzy
branch runs only when full-text search returns nothing, so a rare path could afford to be slow.
That reasoning was sound at Phase 4's volume. It does not survive 1M products: a typo cost the user
**1.7 seconds**, and "rare" is not "never" — it is every misspelling anyone types.

### The fix

`<%` is the indexable operator behind `word_similarity`, honouring `word_similarity_threshold`
(set to 0.4 via `SET LOCAL`, since its default is 0.6). Predicate moves to the operator; **ranking
keeps the function**, because ordering reads already-matched rows and costs nothing to index.

Verified three ways:

- **Identical results** — both forms return the same six SKUs for `'raksah'`, including the
  `raksah → RAKSHA` typo match that HANDOFF §4.11 exists for.
- **Plan** — `Bitmap Index Scan on product_name_trgm_idx`, 0.72 ms vs 1712 ms.
- **Through the application**, at 1M products: typo search **18 ms** (was 1712 ms), exact search
  unaffected at 1 ms, nonsense term returns 0 results.

`verify-search-perf.ts` pins all three.

---

## 4. ADR-0019 stands, and its trigger has technically fired

The top-products panel exceeds the 200 ms revisit threshold at 2.3 s. ADR-0019 predicted precisely
this shape:

> *"The two panels that resist indexing do so for a legible reason: they genuinely have to aggregate
> 120,000 line rows, and no index removes that work."*

At **5,000,000** line rows it is 2.3 s. The prediction was right; only the volume changed.

**The decision should not change**, and the reason is arithmetic rather than preference: 5M order
lines is 417× a generous three-year projection for this business. At the volume Hixaa will actually
reach, the whole dashboard measured ~108 ms in ADR-0019 and every panel here except top-products is
comfortably inside target at 417× that.

**What to do if volume ever approaches this** — recorded so nobody re-derives it:

1. **First**, restrict the panel's window. It aggregates 12 months; most users look at one.
2. **Then**, a rollup table maintained by the existing outbox consumer — not a materialised view.
   ADR-0019's objections to views (staleness contradicting the drill-through list, refresh
   operations, fighting Prisma) all still hold; a narrow incrementally-maintained table has none of
   them.
3. **Only then** reconsider materialised views.

---

## 5. Secondary observations

- **Deep offset passes at 279 ms, which is luck rather than design.** `docs/06` T13 names
  "deep-offset rejection" as the control for this, and **no such rejection exists** — `OFFSET
  500000` is accepted and executed. It passes today because 1M products is small enough. Worth
  implementing the guard T13 already promises.
- **Bulk write cost is index-dominated.** Inserting 1M products took ~12 minutes, driven by a
  per-row `to_tsvector` trigger plus 13 indexes. Relevant to any future data import, and to 11.4's
  sizing.
- **The scope predicate is cheap.** A territory-scoped distributor list is 6.3 ms against 3.0 ms
  unscoped, at 100k rows. ADR-0003's repository-layer scoping costs almost nothing at volume.
- **`top 10 distributors` at 148 ms is the closest passing panel.** It is the one to watch if order
  volume grows.

---

## 6. Two false findings I nearly reported

Recorded because the method matters as much as the numbers.

1. **A misaligned harness.** The first version paired `\echo` labels to `\timing` output by
   position. `\echo` emits its own timing line, so every number was reported under the wrong
   query's name — including a "969 ms revenue KPI" that was actually a different panel. Fixed by
   running each query in isolation.
2. **A pathological fixture.** The first search measurement used the term `'Load Product 5000'`
   against a fixture where every row is named `Load Product N`. It matched ~1M rows and reported
   2.5 s — measuring "match everything", not "find a product". A real typo matches 6 rows. The
   corrected term is in the harness with a comment explaining why.

Both would have produced confident, wrong numbers in a document that reads authoritatively.

---

## 7. Reusable assets

| Script | Purpose |
|---|---|
| `scripts/load-seed.sql` | Seeds the volume. **Resumable** — each section skips itself if loaded, because the product insert alone is ~12 minutes and this fixture needed three corrections |
| `scripts/load-measure.sh` | Runs each query N times, reports min/median/p95 |
| `apps/api/src/scripts/verify-search-perf.ts` | Proves fuzzy search through the application path |

```bash
createdb hixaa_dms_load
DATABASE_URL="postgresql://…/hixaa_dms_load?schema=public" pnpm --filter @hixaa/api exec prisma migrate deploy
DATABASE_URL="postgresql://…/hixaa_dms_load?schema=public" pnpm db:seed
psql "postgresql://…/hixaa_dms_load" -f scripts/load-seed.sql     # ~15 min
./scripts/load-measure.sh "postgresql://…/hixaa_dms_load" 11
```

## 8. Not done

- **No concurrency.** Every measurement is a single connection. Real p95 under N concurrent users
  needs a load generator (k6, autocannon) against the running API, not psql. This measures the
  database's query cost, which is the dominant term — but it is not the same thing.
- **Not measured through HTTP.** Serialisation, the transform interceptor and Nest's pipeline are
  excluded. `verify-search-perf.ts` is the one exception, and it goes through the service layer.
- **Write throughput was observed, not measured.** The ~12-minute product insert is an anecdote
  from bulk loading, not a benchmark.
