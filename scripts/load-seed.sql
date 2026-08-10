-- Phase 11.2 — bulk volume for the load test.
--
-- Roadmap 11.2 specifies 100k distributors, 1M products, 5M order lines.
--
-- ⚠️ Generated with set-based SQL, not Prisma. `createMany` for 5M rows is
-- hours of round-trips; `INSERT … SELECT generate_series` is minutes. This is a
-- volume fixture, not a demonstration of the ORM.
--
-- ⚠️ Run ONLY against a scratch database. It writes millions of rows.
--
--   psql "postgresql://…/hixaa_dms_load" -f scripts/load-seed.sql
--
-- ── Why the numbered temp tables ───────────────────────────────────────────
--
-- The obvious way to pick a random parent is a correlated
-- `SELECT … OFFSET (i % n) LIMIT 1`. That is O(n) per row, so 5M lines against
-- 1M products is 5×10^12 tuple reads and never finishes. Numbering each parent
-- once into a temp table and joining on the number makes it a hash join.
--
-- Deliberately does NOT go through the application: the point is to measure
-- READ performance at volume. The write path's correctness is covered by the
-- phase smoke suites.

\timing on
\set ON_ERROR_STOP on

-- ── Resumable ──────────────────────────────────────────────────────────────
-- Each section skips itself if already loaded. The product insert alone takes
-- ~12 minutes (a per-row `to_tsvector` trigger plus 13 indexes), so a fixture
-- that had to start over on every typo would be unusable — and this one needed
-- three corrections before it was right.

-- ── Distributors: 100,000 ──────────────────────────────────────────────────
-- Spread across every territory so the scope predicate has real selectivity —
-- a load test where one territory holds everything flatters every scoped query.
\echo '── distributors ──'
INSERT INTO distributor (id, code, legal_name, trade_name, status, territory_id,
                         credit_limit, credit_days, created_at, updated_at)
SELECT
  gen_random_uuid(),
  'LOAD-D-' || lpad(i::text, 7, '0'),
  'Load Distributor ' || i,
  'LoadDist' || i,
  (ARRAY['ACTIVE','ACTIVE','ACTIVE','SUSPENDED','PENDING_APPROVAL']::"DistributorStatus"[])[1 + (i % 5)],
  t.id,
  (50000 + (i % 20) * 25000)::numeric(18,4),
  (ARRAY[15,30,45,60])[1 + (i % 4)],
  now() - ((i % 1095) || ' days')::interval,
  now()
FROM generate_series(1, 100000) AS i
JOIN LATERAL (
  SELECT id FROM territory ORDER BY id LIMIT 1 OFFSET (i % (SELECT count(*) FROM territory))
) t ON true
WHERE NOT EXISTS (SELECT 1 FROM distributor WHERE code LIKE 'LOAD-D-%');

-- ── Products: 1,000,000 ────────────────────────────────────────────────────
-- A SERVICE must carry a SAC code, not an HSN — enforced by
-- `product_service_uses_sac`, which rejected the first version of this fixture.
-- Hixaa sells services alongside goods (docs/00), so the fixture has to model
-- both rather than pretend everything is a widget.
\echo '── products ──'
INSERT INTO product (id, sku, name, slug, type, status, category_id, uom_id,
                     hsn_code, sac_code, gst_rate, created_at, updated_at)
SELECT
  gen_random_uuid(),
  'LOAD-P-' || lpad(i::text, 8, '0'),
  'Load Product ' || i,
  'load-product-' || i,
  (ARRAY['GOODS','GOODS','GOODS','SERVICE','KIT']::"ProductType"[])[1 + (i % 5)],
  (ARRAY['ACTIVE','ACTIVE','ACTIVE','DISCONTINUED']::"ProductStatus"[])[1 + (i % 4)],
  c.id,
  u.id,
  CASE WHEN (i % 5) = 3 THEN NULL ELSE '85371000' END,
  CASE WHEN (i % 5) = 3 THEN '998719' ELSE NULL END,
  (ARRAY[5,12,18,28])[1 + (i % 4)]::numeric(5,2),
  now() - ((i % 1095) || ' days')::interval,
  now()
FROM generate_series(1, 1000000) AS i
JOIN LATERAL (SELECT id FROM category ORDER BY id LIMIT 1 OFFSET (i % 19)) c ON true
JOIN LATERAL (SELECT id FROM unit_of_measure ORDER BY id LIMIT 1 OFFSET (i % 10)) u ON true
WHERE NOT EXISTS (SELECT 1 FROM product WHERE sku LIKE 'LOAD-P-%');

-- Numbered lookups, so every parent pick below is a join rather than a scan.
CREATE TEMP TABLE ld AS
  SELECT id, (row_number() OVER (ORDER BY code)) - 1 AS rn
  FROM distributor WHERE code LIKE 'LOAD-D-%';
CREATE INDEX ON ld (rn);

CREATE TEMP TABLE lp AS
  SELECT id, sku, name, (row_number() OVER (ORDER BY sku)) - 1 AS rn
  FROM product WHERE sku LIKE 'LOAD-P-%';
CREATE INDEX ON lp (rn);

ANALYZE ld;
ANALYZE lp;

-- ── Orders: 500,000 ────────────────────────────────────────────────────────
-- 10 lines each gives the 5M order lines the roadmap asks for. Dates spread
-- over three years so the 12-month trend panel has to filter, not scan-and-keep.
\echo '── orders ──'
INSERT INTO "order" (id, number, order_date, type, status, distributor_id,
                     subtotal, taxable_value, total_tax, grand_total,
                     created_at, updated_at)
SELECT
  gen_random_uuid(),
  'LOAD-SO-' || lpad(i::text, 8, '0'),
  (now() - ((i % 1095) || ' days')::interval)::date,
  'PRIMARY'::"OrderType",
  (ARRAY['DRAFT','PENDING_APPROVAL','APPROVED','APPROVED','DISPATCHED','DELIVERED','COMPLETED','CANCELLED']::"OrderStatus"[])[1 + (i % 8)],
  ld.id,
  (10000 + (i % 500) * 100)::numeric(18,4),
  (10000 + (i % 500) * 100)::numeric(18,4),
  ((10000 + (i % 500) * 100) * 0.18)::numeric(18,4),
  ((10000 + (i % 500) * 100) * 1.18)::numeric(18,4),
  now() - ((i % 1095) || ' days')::interval,
  now()
FROM generate_series(1, 500000) AS i
JOIN ld ON ld.rn = i % 100000
WHERE NOT EXISTS (SELECT 1 FROM "order" WHERE number LIKE 'LOAD-SO-%');

CREATE TEMP TABLE lo AS
  SELECT id, (row_number() OVER (ORDER BY number)) - 1 AS rn
  FROM "order" WHERE number LIKE 'LOAD-SO-%';
CREATE INDEX ON lo (rn);
ANALYZE lo;

-- ── Order lines: 5,000,000 ─────────────────────────────────────────────────
\echo '── order lines ──'
INSERT INTO order_line (id, order_id, line_number, product_id, sku, description,
                        quantity, unit_list_price, unit_price, taxable_value,
                        line_total, gst_rate, created_at, updated_at)
SELECT
  gen_random_uuid(),
  lo.id,
  ln.n,
  lp.id,
  lp.sku,
  lp.name,
  (1 + (ln.n % 20))::numeric(18,4),
  (1000 + (lo.rn % 900))::numeric(18,4),
  (1000 + (lo.rn % 900))::numeric(18,4),
  ((1 + (ln.n % 20)) * (1000 + (lo.rn % 900)))::numeric(18,4),
  ((1 + (ln.n % 20)) * (1000 + (lo.rn % 900)) * 1.18)::numeric(18,4),
  18::numeric(5,2),
  now(),
  now()
FROM lo
CROSS JOIN generate_series(1, 10) AS ln(n)
JOIN lp ON lp.rn = (lo.rn * 10 + ln.n) % 1000000
WHERE NOT EXISTS (SELECT 1 FROM order_line ol JOIN "order" o ON o.id = ol.order_id
                  WHERE o.number LIKE 'LOAD-SO-%');

-- Statistics matter more than the rows: without ANALYZE the planner works from
-- defaults and every timing below measures the wrong plan.
ANALYZE;
