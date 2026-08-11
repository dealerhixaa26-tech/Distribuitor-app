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
# The key matters here: /orders and /payments now require one, and the
# interceptor runs BEFORE the validation pipe. Without a key those two would
# still answer 422 — for a missing header rather than an empty body — and the
# check would pass while testing nothing it claims to test.
for ep in distributors products price-lists quotations orders payments customers; do
  check "POST /$ep validates an empty body" 422 \
    "$(code -X POST "$API/$ep" -H "Authorization: Bearer $T" -H "Idempotency-Key: $(uuidgen)" \
       -H 'Content-Type: application/json' -d '{}')"
done

echo "── Idempotency, which until now was a table nothing wrote to (docs/03 §5) ──"
IK=$(uuidgen)
PAY_BODY="{\"distributorId\":\"$(curl -s "$API/distributors?limit=1" -H "Authorization: Bearer $T" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])')\",\"method\":\"UPI\",\"amount\":\"11.00\",\"referenceNumber\":\"IDEM-SMOKE\"}"
check "a money-moving POST without a key is refused" 422 \
  "$(code -X POST "$API/payments" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "$PAY_BODY")"
FIRST=$(curl -s -X POST "$API/payments" -H "Authorization: Bearer $T" -H "Idempotency-Key: $IK" \
        -H 'Content-Type: application/json' -d "$PAY_BODY" \
        | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
check "the first attempt creates a receipt" "yes" "$([ -n "$FIRST" ] && echo yes || echo no)"
# The assertion that matters: the SAME id back, not merely a 2xx. A replay that
# quietly created a second payment would also return 201.
REPLAY=$(curl -s -X POST "$API/payments" -H "Authorization: Bearer $T" -H "Idempotency-Key: $IK" \
         -H 'Content-Type: application/json' -d "$PAY_BODY" \
         | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
check "a retry with the same key returns the SAME receipt" "$FIRST" "$REPLAY"
check "and only ONE row exists for that reference" 1 \
  "$(psql hixaa_dms_dev -tAc "SELECT count(*) FROM payment WHERE reference_number='IDEM-SMOKE';" | tr -d ' ')"
check "the replay is announced in a header" "true" \
  "$(curl -s -D - -o /dev/null -X POST "$API/payments" -H "Authorization: Bearer $T" \
     -H "Idempotency-Key: $IK" -H 'Content-Type: application/json' -d "$PAY_BODY" \
     | awk 'tolower($1)=="idempotency-replayed:"{print tolower($2)}' | tr -d '\r')"
check "the same key with a DIFFERENT body is refused" 409 \
  "$(code -X POST "$API/payments" -H "Authorization: Bearer $T" -H "Idempotency-Key: $IK" \
     -H 'Content-Type: application/json' -d "${PAY_BODY/11.00/22.00}")"
check "a fresh key creates a second receipt" 201 \
  "$(code -X POST "$API/payments" -H "Authorization: Bearer $T" -H "Idempotency-Key: $(uuidgen)" \
     -H 'Content-Type: application/json' -d "${PAY_BODY/IDEM-SMOKE/IDEM-SMOKE-2}")"
# A rejected request must not burn the key, or a client-side typo would strand it.
BADKEY=$(uuidgen)
code -X POST "$API/payments" -H "Authorization: Bearer $T" -H "Idempotency-Key: $BADKEY" \
  -H 'Content-Type: application/json' -d '{"method":"UPI"}' > /dev/null
check "a key used by a REFUSED request is still usable" 201 \
  "$(code -X POST "$API/payments" -H "Authorization: Bearer $T" -H "Idempotency-Key: $BADKEY" \
     -H 'Content-Type: application/json' -d "${PAY_BODY/IDEM-SMOKE/IDEM-SMOKE-3}")"
# Cleanup reports its own failure rather than hiding it (HANDOFF §4.29).
DELETED=$(psql hixaa_dms_dev -tAc "DELETE FROM payment WHERE reference_number LIKE 'IDEM-SMOKE%' RETURNING 1;" | grep -c 1)
check "the three probe receipts were cleaned up" 3 "$DELETED"
psql hixaa_dms_dev -tAc "DELETE FROM idempotency_key WHERE endpoint LIKE '%payments%';" > /dev/null
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
  # /approve is idempotent (docs/03 §5), so a key is needed for the 409 to be
  # the KYC refusal rather than a missing header.
  check "approving one without verified KYC is refused" 409 \
    "$(code -X POST "$API/distributors/$PEND/approve" -H "Authorization: Bearer $T" \
       -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' -d '{}')"
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

echo "── The session survives the access token (middleware fallback) ──"
# The route middleware asks "is there a session?". Its refresh-cookie fallback
# could never fire — that cookie is scoped to /…/auth — so every navigation
# more than ~15 minutes after sign-in bounced to /login mid-session. A marker
# at Path=/ answers the question; it holds the literal 1 and no credential.
MARKER_JAR=$(mktemp)
curl -s -c "$MARKER_JAR" -X POST "$BFF/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@hixaa.com","password":"ChangeMe!Now#2026"}' -o /dev/null
check "a session marker is set at Path=/" "/" \
  "$(awk '$6=="hixaa_session"{print $3}' "$MARKER_JAR")"
check "it outlives the access cookie" "yes" \
  "$(awk '$6=="hixaa_session"{m=$5} $6=="hixaa_at"{a=$5} END{print (m>a)?"yes":"no"}' "$MARKER_JAR")"
grep -v 'hixaa_at' "$MARKER_JAR" > "$MARKER_JAR.expired"
check "a page still loads once the access cookie has gone" 200 \
  "$(code -b "$MARKER_JAR.expired" http://localhost:3000/orders)"
check "and a request with NO cookies is still redirected" 307 \
  "$(code http://localhost:3000/orders)"
rm -f "$MARKER_JAR" "$MARKER_JAR.expired"

echo "── The invoice filter the allocation dialog depends on ──"
DIST1=$(curl -s "$API/distributors?limit=1" -H "Authorization: Bearer $T" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])')
check "outstandingOnly is accepted" 200 \
  "$(code "$API/invoices?distributorId=$DIST1&outstandingOnly=true&limit=50" -H "Authorization: Bearer $T")"
# Pinned because the dialog originally sent this and got a 422 it rendered as
# "this party has no open invoices" — a wrong answer stated confidently.
check "a CSV status list is REFUSED, so nothing may send one" 422 \
  "$(code "$API/invoices?distributorId=$DIST1&status=ISSUED,PARTIALLY_PAID&limit=50" -H "Authorization: Bearer $T")"
check "a single status is accepted" 200 \
  "$(code "$API/invoices?distributorId=$DIST1&status=ISSUED&limit=50" -H "Authorization: Bearer $T")"

echo "── Reference lookups the catalogue forms depend on ──"
check "GET /geography/uoms returns the seeded units" 10 \
  "$(curl -s "$API/geography/uoms" -H "Authorization: Bearer $T" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print(len(d))')"
check "and each carries its GST Unit Quantity Code" "yes" \
  "$(curl -s "$API/geography/uoms" -H "Authorization: Bearer $T" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print("yes" if all(r.get("uqc") for r in d) else "no")')"

# EntityPicker reads two different response shapes and filters differently for
# each: a paginated endpoint has already applied ?q= server-side, a bare array
# has not and must be filtered in the browser. Getting this wrong renders an
# empty list against a 200 OK — which is what /territories did until it was
# found. Pinned so a list endpoint that gains or loses pagination is noticed.
echo "── The two list shapes EntityPicker distinguishes (§4.10) ──"
shape() { curl -s "$API/$1" -H "Authorization: Bearer $T" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("paginated" if isinstance(d,dict) and "meta" in d else "bare-array")'; }
check "/distributors is paginated"            "paginated"  "$(shape 'distributors?limit=1')"
check "/products is paginated"                "paginated"  "$(shape 'products?limit=1')"
check "/territories is a bare array"          "bare-array" "$(shape territories)"
check "/categories is a bare array"           "bare-array" "$(shape categories)"
check "/geography/uoms is a bare array"       "bare-array" "$(shape geography/uoms)"
check "/geography/industries is a bare array" "bare-array" "$(shape geography/industries)"

# An edit form pre-fills from these. Drop one and the form shows a blank where
# data exists, then saves the blank over it — silently, with a 200 both times.
echo "── The editable projections the edit forms pre-fill from ──"
editable() { curl -s "$API/$1" -H "Authorization: Bearer $T" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin).get("data",{});e=d.get("editable");print(",".join(sorted(e)) if isinstance(e,dict) else "MISSING")'; }
D1=$(curl -s "$API/distributors?limit=1" -H "Authorization: Bearer $T" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])')
C1=$(curl -s "$API/customers?limit=1" -H "Authorization: Bearer $T" | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print(d[0]["id"])')
P1=$(curl -s "$API/products?limit=1" -H "Authorization: Bearer $T" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])')
check "distributor detail carries one" \
  "bankAccountName,bankIfsc,bankName,billingAddress,cin,msmeNumber,paymentTermsCode,shippingAddress,tan,website" \
  "$(editable "distributors/$D1")"
check "customer detail carries one" \
  "billingAddress,notes,pan,shippingAddress,website" "$(editable "customers/$C1")"
check "product detail carries one" \
  "description,isPurchasable,isReturnable,isSellable,shortDescription,uomId,weightGrams" \
  "$(editable "products/$P1")"
# uomId is the one that would bite hardest: the summary carries only uomCode, so
# without this an edit form has no id to send back and every save unsets the unit.
check "and it includes uomId, not just uomCode" "yes" \
  "$(curl -s "$API/products/$P1" -H "Authorization: Bearer $T" \
     | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print("yes" if "uomId" in d.get("editable",{}) else "no")')"

echo "── The pricing preview the line editor renders (ADR-0011) ──"
D=$(curl -s "$API/distributors?limit=1" -H "Authorization: Bearer $T" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])')
# Taken from the DEFAULT price list rather than "whatever product sorts first".
# The catalogue grew a product that is priced on a different list, and the
# arbitrary pick started resolving to it — the check failed on correct API
# behaviour, which is a fragile check rather than a bug.
DEFAULT_PL=$(curl -s "$API/price-lists" -H "Authorization: Bearer $T" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print(next(p["id"] for p in d if p.get("isDefault")))')
P=$(curl -s "$API/price-lists/$DEFAULT_PL/items" -H "Authorization: Bearer $T" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);print(d[0]["productId"])')

# The refusal above is worth keeping: a product with no price on the resolved
# list must be REFUSED, never quietly quoted at zero.
UNPRICED=$(curl -s "$API/products?q=BEACON&limit=1" -H "Authorization: Bearer $T" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(d[0]["id"] if d else "")')
if [ -n "$UNPRICED" ]; then
  UNPRICED_BODY="{\"distributorId\":\"$D\",\"lines\":[{\"productId\":\"$UNPRICED\",\"quantity\":\"1\"}]}"
  check "a product absent from the resolved list is REFUSED, not priced at zero" 409 \
    "$(code -X POST "$API/pricing/quote" -H "Authorization: Bearer $T" \
       -H 'Content-Type: application/json' -d "$UNPRICED_BODY")"
fi
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
