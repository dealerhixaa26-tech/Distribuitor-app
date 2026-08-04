# 03 — API Design

> Phase 0 deliverable. Status: **Awaiting approval**
> REST · JSON · OpenAPI 3.1 at `/api/docs` · Base path `/api/v1`

---

## 1. Conventions

| Aspect | Rule |
|---|---|
| **Style** | REST, resource-oriented. Verbs only for genuine state transitions (`POST /orders/{id}/approve`) |
| **Versioning** | URI-based `/api/v1`. Breaking changes create `/v2`; the old version is supported for at least one release cycle |
| **Casing** | `camelCase` JSON bodies, `kebab-case` URL segments, `camelCase` query params |
| **IDs** | UUID v7 strings. Human codes (`SO-2627-00118`) are attributes, never path identifiers |
| **Dates** | ISO 8601 UTC (`2026-08-03T10:15:00Z`). Date-only fields are `YYYY-MM-DD` |
| **Money** | **Strings**, not numbers — `"152400.0000"`. JSON numbers are IEEE-754 doubles and silently lose precision on large amounts. See ADR-0004 |
| **Validation** | Zod schemas from `@hixaa/contracts`, applied by a global pipe. Unknown properties are stripped |
| **Auth** | `Authorization: Bearer <access>` from the BFF; browsers hold an HTTP-only cookie only |

---

## 2. Response envelope

Single resource:
```json
{ "data": { "id": "0192...", "code": "DIST-00042", "legalName": "Vidarbha Automation LLP" } }
```

Collection — **cursor pagination by default**:
```json
{
  "data": [ /* … */ ],
  "meta": {
    "cursor": { "next": "eyJjcmVhdGVkQXQiOi4uLn0", "hasMore": true },
    "totalCount": 1284
  }
}
```

`totalCount` is returned only when `?includeTotal=true`. A `COUNT(*)` over a large filtered set is
often more expensive than the page query itself, so callers must opt in to paying for it.

Offset pagination (`?page=&pageSize=`) remains available for small reference lists and for tables
that genuinely need page numbers, but is rejected beyond `page > 500` to prevent deep-offset scans.

---

## 3. Errors — RFC 7807 Problem Details

```json
{
  "type": "https://api.hixaa.com/problems/insufficient-stock",
  "title": "Insufficient stock",
  "status": 409,
  "detail": "Warehouse WH-NGP-01 has 4 units available; 10 requested.",
  "instance": "/api/v1/orders/0192.../approve",
  "requestId": "01J9X2K7M4",
  "code": "INSUFFICIENT_STOCK",
  "errors": [
    { "field": "lines[2].quantity", "code": "INSUFFICIENT_STOCK", "message": "Only 4 available" }
  ]
}
```

`code` is a stable machine-readable string the frontend switches on. `detail` is human text that may
be reworded freely. `requestId` correlates directly to a log line — the first thing support asks for.

| Status | Used for |
|---|---|
| 400 | Malformed syntax |
| 401 | Missing/expired/invalid token |
| 403 | Authenticated but not permitted, **or out of data scope** |
| 404 | Not found — also returned instead of 403 when revealing existence would leak information |
| 409 | Business conflict: duplicate, invalid state transition, insufficient stock, credit limit |
| 422 | Well-formed but semantically invalid (validation failures) |
| 429 | Rate limited (`Retry-After` header set) |
| 500 | Unexpected — generic message only, details in logs |

**Never leak existence through status codes.** A Sales Executive requesting a distributor outside
their territory gets `404`, not `403` — otherwise the API becomes an enumeration oracle.

---

## 4. Filtering, sorting, searching

```
GET /api/v1/orders
    ?status=APPROVED,PROCESSING          # CSV = OR within a field
    &distributorId=0192...
    &orderDate[gte]=2026-04-01
    &orderDate[lte]=2026-06-30
    &grandTotal[gt]=100000
    &q=vidarbha                          # full-text across indexed fields
    &sort=-orderDate,orderNumber         # '-' prefix = DESC
    &include=distributor,lines           # explicit expansion, allow-listed
    &fields=id,orderNumber,grandTotal    # sparse fieldset
    &cursor=eyJ...&limit=50
```

Every filterable field, sortable field, and includable relation is **declared per resource in an
allow-list**. An un-allow-listed parameter is a 422, not a silent no-op — this both prevents
accidental full scans on unindexed columns and stops filter injection.

`include` depth is capped at 1 level and each expansion is a batched query, never a per-row lookup.

---

## 5. Idempotency

Required on `POST /orders`, `POST /payments`, `POST /invoices`, and every `/approve` action:

```
Idempotency-Key: 3f9c1b2e-... (client-generated UUID)
```

The key, endpoint, and a hash of the request body are stored. A replay with the same key and body
returns the **stored response** with `Idempotency-Replayed: true`. The same key with a *different*
body returns `409`. Keys expire after 24 hours.

This is what makes a flaky mobile connection safe: a retried "approve order" cannot approve twice.

---

## 6. Endpoint catalogue

Every endpoint below enforces both a permission and a data scope. `⚡` marks endpoints that enqueue
background work and return `202 Accepted` with a job handle.

### Auth — `/api/v1/auth`
| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/login` | public | Rate limited 5/15min per IP+email. Returns access + sets refresh cookie |
| POST | `/refresh` | cookie | Rotates refresh token; **reuse of a rotated token revokes the whole family** |
| POST | `/logout` | authed | Revokes the current session |
| POST | `/logout-all` | authed | Revokes every session for the user |
| POST | `/forgot-password` | public | Always `204` regardless of whether the email exists |
| POST | `/reset-password` | token | Single-use token; revokes all sessions on success |
| POST | `/verify-email` | token | |
| GET | `/me` | authed | User + effective permissions + scopes |
| GET | `/sessions` · DELETE `/sessions/{id}` | authed | Session management |
| POST | `/mfa/enroll` · `/mfa/verify` · `/mfa/disable` | authed | TOTP |

### Users, Roles, Teams — `/users` `/roles` `/permissions` `/teams`
Standard CRUD plus `POST /users/{id}/invite`, `POST /users/{id}/suspend`,
`PUT /users/{id}/roles` (scoped assignment), `GET /users/{id}/activity`.

### Distributors — `/distributors`
| Method | Path | Permission |
|---|---|---|
| GET · POST | `/` | `distributor:read` · `distributor:create` |
| GET · PATCH · DELETE | `/{id}` | `distributor:read` · `:update` · `:delete` |
| POST | `/{id}/approve` · `/{id}/suspend` · `/{id}/terminate` | `distributor:approve` |
| GET · POST | `/{id}/contacts` | `distributor:update` |
| GET · POST | `/{id}/documents` | `distributor:document:manage` |
| POST | `/{id}/documents/{docId}/verify` | `distributor:approve` |
| GET · PUT | `/{id}/products` | authorised catalog |
| GET | `/{id}/performance` | `analytics:read` — sales, targets, growth |
| GET | `/{id}/ledger` | `payment:read` — statement of account |
| GET | `/{id}/outstanding` | `payment:read` — aging buckets |
| GET · POST | `/{id}/notes` | `distributor:read` · `:update` |
| POST ⚡ | `/import` | `distributor:import` — CSV/Excel bulk |

### Catalog — `/products` `/categories` `/brands` `/uoms`
CRUD plus `/products/{id}/media`, `/specifications`, `/variants`, `/revisions`, `/bom`,
`POST /products/{id}/duplicate`, `POST /products/import` ⚡, `GET /products/export` ⚡.

### Pricing — `/price-lists` `/discount-rules`
CRUD plus `POST /price-lists/{id}/items/bulk`, `POST /price-lists/{id}/clone`, and
`POST /pricing/quote` — resolves the effective price for a (distributor, product, qty) tuple. That
last one is a single well-tested endpoint so the pricing rule exists in exactly one place and both
the order screen and the quotation screen call it.

### Inventory — `/inventory` `/warehouses` `/stock-transfers`
| Method | Path | Notes |
|---|---|---|
| GET | `/inventory/balances` | Filter by warehouse, product, low-stock |
| GET | `/inventory/ledger` | Immutable movement history |
| POST | `/inventory/receipts` | Goods receipt |
| POST | `/inventory/adjustments` | Requires reason code; `inventory:adjust` |
| GET | `/inventory/low-stock` | Below reorder level |
| GET | `/inventory/serials/{serial}` | Full trace: warehouse → distributor → customer → warranty |
| POST | `/stock-transfers` · `/{id}/dispatch` · `/{id}/receive` | Two-phase, transit stock visible |

### Quotations & Orders — `/quotations` `/orders`
| Method | Path | Notes |
|---|---|---|
| POST | `/quotations/{id}/send` ⚡ | Emails PDF via the **business** channel |
| POST | `/quotations/{id}/convert` | → Order, carrying priced lines forward |
| GET · POST | `/orders` | `type=PRIMARY\|SECONDARY` |
| POST | `/orders/{id}/submit` | DRAFT → PENDING_APPROVAL; runs credit check |
| POST | `/orders/{id}/approve` · `/reject` | `order:approve`; reserves stock on approve |
| POST | `/orders/{id}/cancel` | Releases reservations |
| GET | `/orders/{id}/timeline` | Status history + shipments + invoices + payments |
| POST | `/orders/{id}/shipments` | Creates dispatch, issues stock from the ledger |
| POST | `/shipments/{id}/deliver` | POD capture |

### Finance — `/invoices` `/payments`
| Method | Path | Notes |
|---|---|---|
| POST | `/invoices` | From an order or standalone |
| POST | `/invoices/{id}/issue` | DRAFT → ISSUED. **Allocates the gapless number. Immutable after** |
| POST | `/invoices/{id}/cancel` | Reason mandatory; never deleted |
| POST | `/invoices/{id}/credit-note` | The only legal correction path |
| GET | `/invoices/{id}/pdf` | Streamed, generated once and cached as a `Document` |
| POST ⚡ | `/invoices/{id}/send` | Business email channel |
| GET | `/invoices/aging` | 0–30 / 31–60 / 61–90 / 90+ |
| POST | `/payments` | Idempotent |
| POST | `/payments/{id}/allocate` | Distributes one payment across invoices |
| POST | `/payments/{id}/verify` | `payment:verify` — separated from `payment:create` by design |
| GET ⚡ | `/tax/gstr1` · `/tax/gstr3b` | Period-based statutory export |

### Customers — `/customers`
CRUD, `/{id}/contacts`, `/{id}/orders`, `/{id}/installed-base` (serials deployed at that customer).

### Documents — `/documents`
`POST /documents` (multipart, magic-byte validated, virus-scan hook), `GET /documents/{id}`
(streamed with authorization re-checked, never a public path),
`POST /documents/{id}/link`, `DELETE /documents/{id}`.

### Analytics & Reports — `/analytics` `/reports`
| Method | Path | Notes |
|---|---|---|
| GET | `/analytics/dashboard` | KPI cards. Reads materialised views, Redis-cached 5 min |
| GET | `/analytics/sales-trend` · `/revenue` · `/top-products` · `/top-distributors` · `/regional` | Charts |
| GET | `/analytics/inventory-health` | Stock value, dead stock, stock-outs |
| GET · POST | `/reports` | Saved report definitions |
| POST ⚡ | `/reports/{id}/run` | `format=PDF\|XLSX\|CSV` → `202` + job id |
| GET | `/reports/runs/{jobId}` | Poll status, then download |
| POST | `/reports/{id}/schedule` | Cron + recipients, delivered on the business channel |

### System — `/settings` `/audit-logs` `/notifications` `/backup` `/health`
| Method | Path | Notes |
|---|---|---|
| GET · PUT | `/settings/{category}` | Company profile, branding, portfolio content, feature flags |
| GET | `/audit-logs` | `auditlog:read`. Filter by entity, actor, date |
| GET · PATCH | `/notifications` · `/{id}/read` | In-app notifications, SSE stream at `/notifications/stream` |
| POST ⚡ | `/backup/sheets/sync` | Manual Google Sheets backup |
| GET | `/backup/sheets/jobs` | History and status |
| POST | `/backup/sheets/restore` | `backup:restore`, dry-run by default |
| GET | `/health/live` · `/health/ready` | Unauthenticated, Compose healthchecks |

---

## 7. Long-running operations

Anything that could exceed ~2 seconds returns `202 Accepted` immediately:

```
POST /api/v1/reports/{id}/run   →   202
{ "data": { "jobId": "0192...", "status": "QUEUED", "statusUrl": "/api/v1/reports/runs/0192..." } }
```

Imports, exports, PDF batches, and Sheets syncs all follow this pattern. **No request thread ever
waits on a third-party API.** This is the mechanism behind the Google Sheets non-blocking
requirement.

---

## 8. Real-time

Server-Sent Events at `GET /api/v1/notifications/stream` — one-directional, works through Nginx
without special configuration, and reconnects natively in the browser. WebSockets are unnecessary
for the notification and low-stock-alert use cases, and would add a stateful component to an
otherwise horizontally scalable API.

---

## 9. Security headers & policy on every response

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; object-src 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Cache-Control: no-store            # on every authenticated response
```

CORS allow-lists exact origins from config — never `*`, and `credentials: true`.

---

## 10. OpenAPI

Generated from the Zod contracts, so the specification cannot drift from the implementation. Served
at `/api/docs` (Swagger UI, non-production only) and `/api/docs-json`. CI fails the build if the
committed `openapi.json` differs from the generated one, which turns "the docs are out of date"
into a build error instead of a discovery six months later.
