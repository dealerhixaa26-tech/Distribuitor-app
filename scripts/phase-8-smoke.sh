#!/bin/bash
# Phase 8 regression sweep — re-run after the refactors, against a live API.
API=http://localhost:4000/api/v1
S="$(dirname "$0")"
pass=0; fail=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1 (expected $2, got $3)"; fail=$((fail+1)); fi
}

TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@hixaa.com","password":"ChangeMe!Now#2026"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["accessToken"])')
FM=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"finance.manager@hixaa.test","password":"finance-nagpur-2026"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["accessToken"])')
AC=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"west.accountant@hixaa.test","password":"accounts-vidarbha-2026"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["accessToken"])')

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# A fresh Idempotency-Key per call. The money-moving routes now REQUIRE one
# (docs/03 §5, IdempotencyInterceptor) and the interceptor runs before the
# validation pipe — so without this every check below would get a 422 about a
# missing header and the ones expecting 422 would pass for the wrong reason.
idem() { printf 'Idempotency-Key: %s' "$(uuidgen)"; }

DIST=$(psql hixaa_dms_dev -tAc "SELECT id FROM distributor WHERE code='DIST-00001';")
SEC=$(psql hixaa_dms_dev -tAc "SELECT id FROM \"order\" WHERE number='SO/2026-27-00002';")
TNINV=$(psql hixaa_dms_dev -tAc "SELECT id FROM invoice WHERE number='HTPL/INV/2026-27/00002';")
PAID=$(psql hixaa_dms_dev -tAc "SELECT id FROM invoice WHERE number='HTPL/INV/2026-27/00001';")

echo "── Obligations from docs/22 §7 ──"
check "SECONDARY order refused for invoicing" 409 \
  "$(code -X POST "$API/invoices/from-order/$SEC" -H "Authorization: Bearer $TOKEN" -H "$(idem)" -H 'Content-Type: application/json' -d '{}')"
check "GSTR-1 excludes SECONDARY" 0 \
  "$(curl -s "$API/gst/gstr1?from=2026-04-01&to=2027-03-31" -H "Authorization: Bearer $TOKEN" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print(d["summary"]["excludedSecondaryCount"])')"

echo "── Immutability (ADR-0016) ──"
check "editing an ISSUED invoice refused" 409 \
  "$(code -X PATCH "$API/invoices/$PAID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"notes":"x"}')"
check "deleting an ISSUED invoice refused" 409 \
  "$(code -X DELETE "$API/invoices/$PAID" -H "Authorization: Bearer $TOKEN")"
check "re-issuing an ISSUED invoice refused" 409 \
  "$(code -X POST "$API/invoices/$PAID/issue" -H "Authorization: Bearer $TOKEN" -H "$(idem)" -H 'Content-Type: application/json' -d '{}')"

echo "── Scope (HANDOFF §4.4, §4.14) ──"
check "out-of-zone READ refused" 404 \
  "$(code "$API/invoices/$TNINV" -H "Authorization: Bearer $AC")"
check "out-of-zone WRITE refused" 404 \
  "$(code -X PATCH "$API/invoices/$TNINV" -H "Authorization: Bearer $AC" -H 'Content-Type: application/json' -d '{"notes":"x"}')"
check "out-of-zone DELETE refused" 404 \
  "$(code -X DELETE "$API/invoices/$TNINV" -H "Authorization: Bearer $AC")"
check "in-zone READ permitted" 200 \
  "$(code "$API/invoices/$PAID" -H "Authorization: Bearer $AC")"

echo "── Segregation (ADR-0018) ──"
P=$(curl -s -X POST "$API/payments" -H "Authorization: Bearer $TOKEN" -H "$(idem)" -H 'Content-Type: application/json' \
  -d "{\"distributorId\":\"$DIST\",\"method\":\"UPI\",\"amount\":\"100.00\",\"referenceNumber\":\"REGRESSION\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
check "recording writes NO ledger entry" "$(psql hixaa_dms_dev -tAc "SELECT count(*) FROM ledger_entry WHERE ref_id='$P';")" 0
# Body built in a variable: nesting escaped double quotes inside
# "$(code ... -d "...")" mangles the JSON and yields a spurious 400.
ALLOC_BODY=$(printf '{"allocations":[{"invoiceId":"%s","amount":"100.00"}]}' "$PAID")
check "allocating a RECORDED receipt refused" 409 \
  "$(code -X POST "$API/payments/$P/allocate" -H "Authorization: Bearer $TOKEN" -H "$(idem)" -H 'Content-Type: application/json' -d "$ALLOC_BODY")"
check "self-verification refused" 403 \
  "$(code -X POST "$API/payments/$P/verify" -H "Authorization: Bearer $TOKEN" -H "$(idem)" -H 'Content-Type: application/json' -d '{}')"
check "verification by another user permitted" 201 \
  "$(code -X POST "$API/payments/$P/verify" -H "Authorization: Bearer $FM" -H "$(idem)" -H 'Content-Type: application/json' -d '{}')"
check "verification DOES write ledger entries" "$(psql hixaa_dms_dev -tAc "SELECT count(*) FROM ledger_entry WHERE ref_id='$P';")" 1
check "a VERIFIED receipt cannot be edited" 409 \
  "$(code -X PATCH "$API/payments/$P" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"amount":"999.00"}')"

echo "── Reports ──"
check "aging report renders" 200 "$(code "$API/outstanding" -H "Authorization: Bearer $TOKEN")"
check "statement renders" 200 "$(code "$API/ledger/DISTRIBUTOR/$DIST" -H "Authorization: Bearer $TOKEN")"
check "GSTR-3B renders" 200 "$(code "$API/gst/gstr3b?from=2026-04-01&to=2027-03-31" -H "Authorization: Bearer $TOKEN")"
check "invoice PDF renders" 200 "$(code "$API/invoices/$PAID/pdf" -H "Authorization: Bearer $TOKEN")"

echo ""
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
