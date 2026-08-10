#!/bin/bash
# Phase 11 forms smoke — the write path the admin UI actually uses.
#
# Unlike phase-8/9-smoke, this drives the BFF on :3000 rather than the API on
# :4000, because that is the path a form takes and it is where the CSRF control
# turned out to be unreachable (ADR-0026). A check that only exercised :4000
# would have passed against the broken guard.
#
# Run with `pnpm dev` up. Every check asserts a REFUSAL or a COUNT, never that
# a request merely completed.

BFF=http://localhost:3000/api/bff
export API=http://localhost:4000/api/v1
pass=0; fail=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1 (expected $2, got $3)"; fail=$((fail+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

curl -s -c "$JAR" -X POST "$BFF/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@hixaa.com","password":"ChangeMe!Now#2026"}' -o /dev/null
CSRF=$(awk '$6=="csrf_token"{print $7}' "$JAR")
RUN='{"type":"SALES_SUMMARY","parameters":{"from":"2026-04-01","to":"2026-08-11"}}'

echo "── Sign-in through the BFF ──"
check "the CSRF cookie is readable by JavaScript" "yes" "$([ -n "$CSRF" ] && echo yes || echo no)"
check "the access token is NOT in the body" "no" \
  "$(curl -s -b "$JAR" -X POST "$BFF/auth/login" -H 'Content-Type: application/json' \
     -d '{"email":"admin@hixaa.com","password":"ChangeMe!Now#2026"}' \
     | python3 -c 'import sys,json;print("yes" if "accessToken" in json.load(sys.stdin).get("data",{}) else "no")')"

echo "── CSRF is enforced on the path forms use (ADR-0026) ──"
# The negative cases come first deliberately: the guard used to accept all
# three, and only a refusal distinguishes an enforced control from an absent one.
check "a mutation with NO CSRF header is refused" 401 \
  "$(code -b "$JAR" -X POST "$BFF/reports/run" -H 'Content-Type: application/json' -d "$RUN")"
check "a mutation with a FORGED CSRF header is refused" 401 \
  "$(code -b "$JAR" -X POST "$BFF/reports/run" -H 'Content-Type: application/json' \
     -H 'X-CSRF-Token: forged.value' -d "$RUN")"
check "a mutation with an UNSIGNED CSRF header is refused" 401 \
  "$(code -b "$JAR" -X POST "$BFF/reports/run" -H 'Content-Type: application/json' \
     -H "X-CSRF-Token: ${CSRF%%.*}" -d "$RUN")"
check "and the correct header is accepted" 201 \
  "$(code -b "$JAR" -X POST "$BFF/reports/run" -H 'Content-Type: application/json' \
     -H "X-CSRF-Token: $CSRF" -d "$RUN")"
check "a READ needs no CSRF header" 200 "$(code -b "$JAR" "$BFF/distributors?limit=1")"
# A server-to-server caller holds a bearer token and sends no cookies at all.
# That exemption is the reason the guard was unreachable, so it is pinned here.
T=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"admin@hixaa.com","password":"ChangeMe!Now#2026"}' \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["accessToken"])')
check "a cookie-free bearer caller is still exempt" 201 \
  "$(code -X POST "$API/reports/run" -H "Authorization: Bearer $T" \
     -H 'Content-Type: application/json' -d "$RUN")"

echo "── Reference data the address form depends on ──"
SID=$(curl -s "$API/geography/states" -H "Authorization: Bearer $T" \
      | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("data",d)[0]["id"])')
check "cities for a real state resolve" 200 \
  "$(code "$API/geography/cities?stateId=$SID" -H "Authorization: Bearer $T")"
check "a malformed stateId is a 422, not a 500" 422 \
  "$(code "$API/geography/cities?stateId=not-a-uuid" -H "Authorization: Bearer $T")"
check "an absent stateId still lists cities" 200 \
  "$(code "$API/geography/cities" -H "Authorization: Bearer $T")"

echo "── The create endpoints forms will post to ──"
for ep in distributors products price-lists quotations orders payments customers; do
  check "POST /$ep validates an empty body" 422 \
    "$(code -X POST "$API/$ep" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{}')"
done
SK=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
     -d '{"email":"west.storekeeper@hixaa.test","password":"storekeeper-nagpur-2026"}' \
     | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["accessToken"])')
check "POST /distributors refused without the permission" 403 \
  "$(code -X POST "$API/distributors" -H "Authorization: Bearer $SK" \
     -H 'Content-Type: application/json' -d '{}')"

echo "── An action is not a status transition (HANDOFF §4.21, ADR-0025) ──"
# Both `approve` and `reactivate` end at ACTIVE, so the transition table cannot
# tell them apart. Guarding reactivation with the table alone let a
# PENDING_APPROVAL partner reach ACTIVE without verified KYC. Asserted as a
# REFUSAL on a real record, because a check that only exercised `approve` passed
# against the broken build.
PEND=$(curl -s "$API/distributors?status=PENDING_APPROVAL&limit=1" -H "Authorization: Bearer $T" \
       | python3 -c 'import sys,json;d=json.load(sys.stdin).get("data") or [];print(d[0]["id"] if d else "")')
if [ -z "$PEND" ]; then
  echo "  FAIL  no PENDING_APPROVAL distributor to test against (fixture missing)"
  fail=$((fail+1))
else
  check "reactivating a PENDING_APPROVAL partner is refused" 409 \
    "$(code -X POST "$API/distributors/$PEND/reactivate" -H "Authorization: Bearer $T" \
       -H 'Content-Type: application/json' -d '{}')"
  check "approving one without verified KYC is refused" 409 \
    "$(code -X POST "$API/distributors/$PEND/approve" -H "Authorization: Bearer $T" \
       -H 'Content-Type: application/json' -d '{}')"
  check "and it is still PENDING_APPROVAL afterwards" "PENDING_APPROVAL" \
    "$(curl -s "$API/distributors/$PEND" -H "Authorization: Bearer $T" \
       | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("data",d)["status"])')"
fi

echo "── Server field errors are addressable by a form ──"
# The paths a form must be able to attach to a field. Asserted as a set, so a
# rename on either side shows up here rather than as an error nothing displays.
check "nested object errors carry a dotted path" "billingAddress.line1" \
  "$(curl -s -X POST "$API/distributors" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
     -d '{"legalName":"Probe","billingAddress":{"cityName":"Nagpur"}}' \
     | python3 -c 'import sys,json;print(json.load(sys.stdin)["errors"][0]["field"])')"
check "line errors carry an indexed path" "lines[0].productId" \
  "$(curl -s -X POST "$API/quotations" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
     -d '{"distributorId":"019fca7a-75fb-7933-90a7-3e8e0a1edb66","lines":[{"productId":"x","quantity":"1"}]}' \
     | python3 -c 'import sys,json;print(json.load(sys.stdin)["errors"][0]["field"])')"

echo "── The pricing preview the line editor renders (ADR-0011) ──"
D=$(curl -s "$API/distributors?limit=1" -H "Authorization: Bearer $T" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])')
P=$(curl -s "$API/products?limit=1" -H "Authorization: Bearer $T" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])')
# Built into variables first, deliberately. Inside "$( … )" bash strips the
# backslashes from \" while processing the OUTER double quotes, so the inner
# command sees bare {…,…} and brace-expands one request into three — each a
# fragment the API rejects. It fails loudly here; in a check that only asserted
# a status code it would have looked like a pass.
QUOTE_BODY="{\"distributorId\":\"$D\",\"lines\":[{\"productId\":\"$P\",\"quantity\":\"2\"}]}"
PRICED_BODY="{\"distributorId\":\"$D\",\"lines\":[{\"productId\":\"$P\",\"quantity\":\"2\",\"unitPrice\":\"1.00\",\"price\":\"1.00\"}]}"

check "quote returns a priced line the client never supplied" "yes" \
  "$(curl -s -X POST "$API/pricing/quote" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
     -d "$QUOTE_BODY" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);l=d["lines"][0];print("yes" if l["unitPrice"] and l["lineTotal"] else "no")')"
# A posted price must be ignored, not honoured — otherwise the pricing engine is
# advisory and every discount ceiling is bypassable (HANDOFF §4.16).
check "a price posted by the client is ignored" "yes" \
  "$(curl -s -X POST "$API/pricing/quote" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
     -d "$PRICED_BODY" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print("yes" if float(d["lines"][0]["unitPrice"])>1 else "no")')"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
