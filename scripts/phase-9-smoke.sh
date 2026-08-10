#!/bin/bash
# Phase 9 smoke — analytics, reports, search, notifications, and the two
# obligations Phase 8 placed on this phase. Run against a booted API.
# Exported, not merely assigned: the reconciliation check below reads these
# from os.environ in a python heredoc. Without `export` it died with a KeyError
# every run since this file was written — the check never once compared the two
# totals it exists to compare.
export API=http://localhost:4000/api/v1
pass=0; fail=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1 (expected $2, got $3)"; fail=$((fail+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
login() { curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' -d "$1" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("accessToken",""))'; }

export T=$(login '{"email":"admin@hixaa.com","password":"ChangeMe!Now#2026"}')
SK=$(login '{"email":"west.storekeeper@hixaa.test","password":"storekeeper-nagpur-2026"}')

echo "── Analytics panels ──"
for ep in kpis sales-trend top-products top-distributors by-territory inventory-health receivables activity; do
  check "/analytics/$ep" 200 "$(code "$API/analytics/$ep" -H "Authorization: Bearer $T")"
done

echo "── Financial gating (money ABSENT, not zero) ──"
check "money present for admin" "yes" \
  "$(curl -s "$API/analytics/kpis" -H "Authorization: Bearer $T" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print("yes" if "revenue" in d else "no")')"
check "money ABSENT without analytics:read:financial" "no" \
  "$(curl -s "$API/analytics/kpis" -H "Authorization: Bearer $SK" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print("yes" if "revenue" in d else "no")')"
check "operational counts still present" "yes" \
  "$(curl -s "$API/analytics/kpis" -H "Authorization: Bearer $SK" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print("yes" if "orderCount" in d else "no")')"
check "/analytics/receivables refused outright" 403 \
  "$(code "$API/analytics/receivables" -H "Authorization: Bearer $SK")"

echo "── Phase 8 obligation: stock valuation excludes DISTRIBUTOR warehouses ──"
check "owned value excludes channel stock" "1680000.0000" \
  "$(curl -s "$API/analytics/inventory-health" -H "Authorization: Bearer $T" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print(d.get("ownedStockValue"))')"
check "channel value reported SEPARATELY" "336000.0000" \
  "$(curl -s "$API/analytics/inventory-health" -H "Authorization: Bearer $T" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print(d.get("channelStockValue"))')"
check "STOCK_VALUATION report shows no DISTRIBUTOR warehouse" "0" \
  "$(curl -s -X POST "$API/reports/run" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
     -d '{"type":"STOCK_VALUATION","parameters":{}}' \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print(sum(1 for r in d["rows"] if "CHANNEL" in r["warehouseName"]))')"

echo "── Reconciliation: the dashboard must agree with the screens it links to ──"
check "receivables total == outstanding report total" "same" \
  "$(python3 - <<'PY'
import json,subprocess,os
api=os.environ["API"]; t=os.environ["T"]
def get(p):
    out=subprocess.run(["curl","-s",api+p,"-H","Authorization: Bearer "+t],capture_output=True,text=True).stdout
    d=json.loads(out); return d.get("data",d)
a=get("/analytics/receivables")["totals"]["total"]
b=get("/outstanding")["totals"]["total"]
print("same" if a==b else a+" vs "+b)
PY
)"

echo "── Reports catalogue (ADR-0020) ──"
check "catalogue lists six types" 6 \
  "$(curl -s "$API/reports/catalogue" -H "Authorization: Bearer $T" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print(len(d["reports"]))')"
check "invalid parameters refused" 422 \
  "$(code -X POST "$API/reports/run" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
     -d '{"type":"SALES_SUMMARY","parameters":{"from":"not-a-date"}}')"
check "report refused without financial permission" 403 \
  "$(code -X POST "$API/reports/run" -H "Authorization: Bearer $SK" -H 'Content-Type: application/json' \
     -d '{"type":"SALES_SUMMARY","parameters":{"from":"2026-04-01","to":"2026-08-05"}}')"

echo "── Search: scoped, and typo-tolerant ──"
check "typo 'raksah' still finds products" "yes" \
  "$(curl -s "$API/search?q=raksah" -H "Authorization: Bearer $T" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print("yes" if d["totalHits"]>0 else "no")')"
check "admin sees all 3 invoices" 3 \
  "$(curl -s "$API/search?q=HTPL/INV" -H "Authorization: Bearer $T" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print(sum(len(g["hits"]) for g in d["groups"] if g["entity"]=="INVOICE"))')"
check "scoped user sees only in-zone invoices" 2 \
  "$(curl -s "$API/search?q=HTPL/INV" -H "Authorization: Bearer $SK" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print(sum(len(g["hits"]) for g in d["groups"] if g["entity"]=="INVOICE"))')"

echo "── Notifications ──"
check "unread count returns" 200 "$(code "$API/notifications/unread-count" -H "Authorization: Bearer $T")"
check "notifications exist (outbox drained)" "yes" \
  "$(curl -s "$API/notifications?limit=1" -H "Authorization: Bearer $T" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print("yes" if len(d)>0 else "no")')"

echo ""
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
