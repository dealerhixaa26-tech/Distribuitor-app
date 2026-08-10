#!/usr/bin/env bash
#
# Phase 11.2 — measure query latency at load-test volume.
#
#   scripts/load-measure.sh "postgresql://…/hixaa_dms_load" [runs]
#
# ── Why this is a shell loop and not one .sql file ─────────────────────────
#
# Two reasons, both learned the hard way.
#
# 1. `\timing` emits one line per statement INCLUDING `\echo` and the volume
#    query, so pairing labels to timings by position silently misaligns and
#    reports one query's number under another's name. The first version of this
#    harness did exactly that.
# 2. The target in `docs/00` is **p95 < 300 ms**, and a single sample cannot
#    answer a percentile question. Each query runs N times and reports
#    min / median / p95.
#
# The first run of each query is discarded as a warm-up: a cold read measures
# the disk, and the dashboard sits behind a 5-minute cache, so the case that
# matters is a warm miss rather than a cold boot.
set -uo pipefail

URL="${1:-postgresql://sidhant@localhost:5432/hixaa_dms_load}"
RUNS="${2:-11}"

# Each entry: label :: SQL
run_one () {
  local label="$1" sql="$2"
  local times=()

  # Warm-up, discarded.
  psql "$URL" -q -c "$sql" >/dev/null 2>&1

  for _ in $(seq 1 "$RUNS"); do
    local t
    t=$(psql "$URL" -q -A -t -c "\timing on" -c "$sql" 2>/dev/null | grep -oE 'Time: [0-9.]+' | tail -1 | awk '{print $2}')
    [ -n "$t" ] && times+=("$t")
  done

  if [ ${#times[@]} -eq 0 ]; then printf "  %-42s  FAILED\n" "$label"; return; fi

  printf '%s\n' "${times[@]}" | sort -g | awk -v label="$label" -v n="${#times[@]}" '
    { v[NR]=$1 }
    END {
      p95i = int(n*0.95); if (p95i < 1) p95i = 1;
      printf "  %-42s  min %8.1f   median %8.1f   p95 %8.1f  ms\n", label, v[1], v[int((n+1)/2)], v[p95i];
    }'
}

echo "── volume ──"
psql "$URL" -q -A -t -F'  ' -c "
  SELECT 'distributor', to_char(count(*),'FM999,999,999') FROM distributor
  UNION ALL SELECT 'product', to_char(count(*),'FM999,999,999') FROM product
  UNION ALL SELECT 'order', to_char(count(*),'FM999,999,999') FROM \"order\"
  UNION ALL SELECT 'order_line', to_char(count(*),'FM999,999,999') FROM order_line
  ORDER BY 1;" | sed 's/^/  /'
psql "$URL" -q -A -t -c "SELECT pg_size_pretty(pg_database_size(current_database()));" | sed 's/^/  size: /'
echo "  runs per query: $RUNS (first discarded as warm-up)"
echo

echo "── dashboard panels (ADR-0019 revisits at >200 ms) ──"
run_one "revenue KPI, month" "SELECT coalesce(sum(grand_total),0), count(*) FROM \"order\" WHERE order_date >= date_trunc('month', now()) AND status NOT IN ('DRAFT','CANCELLED','REJECTED');"
run_one "sales trend, 12 months" "SELECT date_trunc('month',order_date), sum(grand_total), count(*) FROM \"order\" WHERE order_date >= now() - interval '12 months' AND status NOT IN ('DRAFT','CANCELLED','REJECTED') GROUP BY 1 ORDER BY 1;"
run_one "top 10 products (5M line agg)" "SELECT ol.product_id, sum(ol.line_total) r FROM order_line ol JOIN \"order\" o ON o.id=ol.order_id WHERE o.order_date >= now() - interval '12 months' AND o.status NOT IN ('DRAFT','CANCELLED','REJECTED') GROUP BY 1 ORDER BY r DESC LIMIT 10;"
run_one "top 10 distributors" "SELECT o.distributor_id, sum(o.grand_total) r FROM \"order\" o WHERE o.order_date >= now() - interval '12 months' AND o.status NOT IN ('DRAFT','CANCELLED','REJECTED') GROUP BY 1 ORDER BY r DESC LIMIT 10;"
run_one "revenue by territory" "SELECT d.territory_id, sum(o.grand_total) r FROM \"order\" o JOIN distributor d ON d.id=o.distributor_id WHERE o.order_date >= now() - interval '12 months' AND o.status NOT IN ('DRAFT','CANCELLED','REJECTED') GROUP BY 1 ORDER BY r DESC;"
echo

echo "── list endpoints (docs/00 target: p95 < 300 ms) ──"
run_one "distributors, page 1" "SELECT id,code,legal_name,status FROM distributor WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 25;"
run_one "products, page 1" "SELECT id,sku,name,status FROM product WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 25;"
run_one "orders, page 1" "SELECT id,number,order_date,status,grand_total FROM \"order\" WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 25;"
run_one "distributors, scoped to 1 territory" "SELECT id,code,legal_name FROM distributor WHERE deleted_at IS NULL AND territory_id=(SELECT id FROM territory ORDER BY id LIMIT 1) ORDER BY created_at DESC, id DESC LIMIT 25;"
echo

echo "── search and pagination ──"
# ⚠️ A SELECTIVE term. The first version searched 'Load Product 5000', which is
# similar to every row in the fixture, so it measured "match 1M rows" rather
# than "find a product" — and reported a false 2.5 s finding. The term below
# matches 6 rows, which is what a real typo does.
run_one "fuzzy search — FUNCTION form (old)" "SELECT id,sku,name FROM product WHERE deleted_at IS NULL AND GREATEST(word_similarity('raksah', name), word_similarity('raksah', sku)) > 0.4 ORDER BY GREATEST(word_similarity('raksah', name), word_similarity('raksah', sku)) DESC LIMIT 20;"
run_one "fuzzy search — OPERATOR form (new)" "BEGIN; SET LOCAL pg_trgm.word_similarity_threshold = 0.4; SELECT id,sku,name FROM product WHERE deleted_at IS NULL AND ('raksah' <% name OR 'raksah' <% sku) ORDER BY GREATEST(word_similarity('raksah', name), word_similarity('raksah', sku)) DESC LIMIT 20; COMMIT;"
run_one "deep offset 500k (docs/06 T13)" "SELECT id,sku FROM product WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC OFFSET 500000 LIMIT 25;"
