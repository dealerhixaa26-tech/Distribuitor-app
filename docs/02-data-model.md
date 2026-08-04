# 02 — Database Schema & ER Diagrams

> Phase 0 deliverable. Status: **Awaiting approval**
> Target: PostgreSQL 16 · Prisma ORM · ~70 tables across 9 bounded contexts

---

## 0. Conventions applied to every table

| Convention | Rule |
|---|---|
| **Primary key** | `id` — UUID v7 (time-sortable, so index locality matches insert order; avoids the random-UUID B-tree fragmentation problem) |
| **Timestamps** | `createdAt`, `updatedAt` on every table; `deletedAt` on every soft-deletable table |
| **Attribution** | `createdById`, `updatedById` on all business entities |
| **Soft delete** | `deletedAt TIMESTAMPTZ NULL`. Enforced by Prisma extension. Financial documents are **never** deleted, only cancelled |
| **Money** | `DECIMAL(18,4)` — never `float`/`double`. Wrapped by a `Money` value object. See ADR-0004 |
| **Quantity** | `DECIMAL(18,4)` — services bill in fractional hours |
| **Percent** | `DECIMAL(7,4)` — supports 18.5000% and 0.0125% |
| **Enums** | Native Postgres enums via Prisma. Additive-only changes |
| **Naming** | `snake_case` in Postgres, `camelCase` in Prisma/TS via `@map` |
| **Human codes** | Every business entity has a human-readable `code` (`DIST-00042`, `SO-2627-00118`) separate from its UUID |
| **Timezone** | All timestamps `TIMESTAMPTZ`, stored UTC. `Asia/Kolkata` applied at presentation only |

---

## 1. Identity, Access & Audit

```mermaid
erDiagram
    USER ||--o{ USER_ROLE : has
    ROLE ||--o{ USER_ROLE : "assigned via"
    ROLE ||--o{ ROLE_PERMISSION : grants
    PERMISSION ||--o{ ROLE_PERMISSION : "granted by"
    USER ||--o{ SESSION : owns
    USER ||--o{ MFA_FACTOR : registers
    USER ||--o{ PASSWORD_RESET_TOKEN : requests
    USER ||--o{ EMAIL_VERIFICATION_TOKEN : requests
    USER ||--o{ TEAM_MEMBER : "belongs to"
    TEAM ||--o{ TEAM_MEMBER : contains
    USER ||--o{ AUDIT_LOG : "acts in"
    USER ||--o{ NOTIFICATION : receives

    USER {
        uuid id PK
        citext email UK
        text password_hash "argon2id"
        text first_name
        text last_name
        text phone
        uuid avatar_document_id FK
        enum status "INVITED|ACTIVE|SUSPENDED|DISABLED"
        timestamptz email_verified_at
        bool mfa_enabled
        int failed_login_attempts
        timestamptz locked_until
        bool must_change_password
        timestamptz last_login_at
        timestamptz deleted_at
    }
    ROLE {
        uuid id PK
        text key UK "SALES_MANAGER"
        text name
        enum scope_type "GLOBAL|TERRITORY|DISTRIBUTOR"
        bool is_system "cannot be deleted"
        int level "for approval hierarchy"
    }
    PERMISSION {
        uuid id PK
        text key UK "order:approve"
        text resource
        text action
        text description
    }
    USER_ROLE {
        uuid id PK
        uuid user_id FK
        uuid role_id FK
        enum scope_type "GLOBAL|TERRITORY|DISTRIBUTOR"
        uuid scope_id "null when GLOBAL"
        timestamptz expires_at
    }
    SESSION {
        uuid id PK
        uuid user_id FK
        text refresh_token_hash UK "sha256"
        uuid family_id "rotation lineage"
        uuid replaced_by_id FK
        inet ip_address
        text user_agent
        bool remember_me
        timestamptz expires_at
        timestamptz revoked_at
        text revoked_reason
    }
    AUDIT_LOG {
        uuid id PK
        uuid actor_user_id FK
        enum actor_type "USER|SYSTEM|API_KEY"
        enum category "AUTH|DATA|SECURITY|INTEGRATION"
        text action "distributor.updated"
        text entity_type
        uuid entity_id
        jsonb before
        jsonb after
        inet ip_address
        text request_id
        timestamptz created_at "PARTITION KEY"
    }
```

**`USER_ROLE.scope_type` + `scope_id` is the single mechanism** that will make the future
Distributor Portal safe. A distributor user is simply a `User` with a role assignment scoped to
`DISTRIBUTOR:<id>`. No parallel user table, no second auth system. See ADR-0003.

Also in this context: `TEAM`, `TEAM_MEMBER`, `MFA_FACTOR` (TOTP secret encrypted at rest, backup
codes hashed), `API_KEY` (hashed, scoped, expiring), `IDEMPOTENCY_KEY`.

---

## 2. Geography & Organisation

```mermaid
erDiagram
    COUNTRY ||--o{ STATE : contains
    STATE ||--o{ CITY : contains
    STATE ||--o{ ADDRESS : "located in"
    TERRITORY ||--o{ TERRITORY : "parent of"
    TERRITORY ||--o{ DISTRIBUTOR : covers
    TERRITORY ||--o{ WAREHOUSE : contains
    ADDRESS ||--o{ WAREHOUSE : "sited at"

    STATE {
        uuid id PK
        uuid country_id FK
        text name
        text code "MH"
        text gst_state_code UK "27 - drives CGST/SGST vs IGST"
    }
    TERRITORY {
        uuid id PK
        text code UK
        text name
        uuid parent_id FK
        enum type "ZONE|REGION|STATE|DISTRICT"
        text path "materialized path for subtree queries"
        int depth
        uuid manager_id FK
        bool is_active
    }
    WAREHOUSE {
        uuid id PK
        text code UK
        text name
        enum type "COMPANY|DISTRIBUTOR|TRANSIT|SCRAP"
        uuid distributor_id FK "set when type=DISTRIBUTOR"
        uuid address_id FK
        uuid territory_id FK
        bool is_default
        bool is_active
    }
```

`STATE.gst_state_code` is not decoration — it is the input to the place-of-supply rule that decides
whether a line is taxed CGST+SGST or IGST. Getting it wrong produces legally incorrect invoices.

`TERRITORY.path` (materialised path, e.g. `west/maharashtra/vidarbha`) makes "all orders in the West
zone" a single indexed `path LIKE 'west/%'` instead of a recursive CTE per request.

---

## 3. Distributors (Channel Partners)

```mermaid
erDiagram
    DISTRIBUTOR ||--o{ DISTRIBUTOR_CONTACT : has
    DISTRIBUTOR ||--o{ DISTRIBUTOR_DOCUMENT : "KYC"
    DISTRIBUTOR ||--o{ DISTRIBUTOR_PRODUCT : "authorised for"
    DISTRIBUTOR ||--o{ DISTRIBUTOR_NOTE : has
    DISTRIBUTOR ||--o{ AGREEMENT : signs
    DISTRIBUTOR ||--o{ ORDER : places
    DISTRIBUTOR ||--o{ INVOICE : "billed on"
    DISTRIBUTOR ||--o{ PAYMENT : makes
    DISTRIBUTOR ||--o{ LEDGER_ENTRY : "accrues"
    DISTRIBUTOR ||--o{ CUSTOMER : serves
    DISTRIBUTOR ||--|| PRICE_LIST : "priced by"

    DISTRIBUTOR {
        uuid id PK
        text code UK "DIST-00042"
        text legal_name
        text trade_name
        enum type "DISTRIBUTOR|DEALER|SYSTEM_INTEGRATOR|OEM_PARTNER"
        enum status "LEAD|PENDING_APPROVAL|ACTIVE|SUSPENDED|TERMINATED"
        uuid territory_id FK
        uuid account_manager_id FK "User"
        uuid price_list_id FK
        uuid billing_address_id FK
        uuid shipping_address_id FK
        text gstin "15 char, validated"
        text pan "10 char, validated"
        text tan
        text cin
        text msme_number
        decimal credit_limit "18,4"
        int credit_days
        decimal opening_balance
        text bank_account_name
        text bank_account_number "encrypted"
        text bank_ifsc
        text[] tags
        timestamptz onboarded_at
        timestamptz deleted_at
    }
    DISTRIBUTOR_CONTACT {
        uuid id PK
        uuid distributor_id FK
        text name
        text designation
        citext email
        text phone
        bool is_primary
        uuid portal_user_id FK "links to USER for v2 portal"
    }
    DISTRIBUTOR_DOCUMENT {
        uuid id PK
        uuid distributor_id FK
        uuid document_id FK
        enum type "GST_CERTIFICATE|PAN_CARD|AGREEMENT|CANCELLED_CHEQUE|MSME_CERT|OTHER"
        date expires_at
        timestamptz verified_at
        uuid verified_by_id FK
    }
    AGREEMENT {
        uuid id PK
        uuid distributor_id FK
        date start_date
        date end_date
        decimal target_amount
        uuid document_id FK
        enum status "DRAFT|ACTIVE|EXPIRED|TERMINATED"
    }
```

`DISTRIBUTOR_CONTACT.portal_user_id` is the seam for the v2 portal: onboarding a distributor user
is creating a `User` and linking it, not building a new subsystem.

---

## 4. Catalog & Pricing

```mermaid
erDiagram
    CATEGORY ||--o{ CATEGORY : "parent of"
    CATEGORY ||--o{ PRODUCT : classifies
    BRAND ||--o{ PRODUCT : brands
    UNIT_OF_MEASURE ||--o{ PRODUCT : measures
    PRODUCT ||--o{ PRODUCT_VARIANT : "sold as"
    PRODUCT ||--o{ PRODUCT_REVISION : "versioned by"
    PRODUCT ||--o{ PRODUCT_MEDIA : "documented by"
    PRODUCT ||--o{ PRODUCT_SPECIFICATION : "specified by"
    PRODUCT ||--o{ PRODUCT_BOM : "assembled from"
    PRODUCT ||--o{ PRICE_LIST_ITEM : priced
    PRICE_LIST ||--o{ PRICE_LIST_ITEM : contains
    PRODUCT ||--o{ ORDER_LINE : "ordered as"
    TAX_RATE ||--o{ PRODUCT : "taxed by HSN"

    PRODUCT {
        uuid id PK
        text sku UK
        text name
        text slug UK
        enum type "GOODS|SERVICE|KIT|CONFIGURABLE"
        enum status "DRAFT|ACTIVE|DISCONTINUED|ARCHIVED"
        uuid category_id FK
        uuid brand_id FK
        uuid uom_id FK
        text hsn_code "goods"
        text sac_code "services"
        decimal gst_rate "snapshot, authoritative = TAX_RATE"
        bool is_serialized
        bool is_batch_tracked
        int warranty_months
        int lead_time_days
        decimal min_order_qty
        decimal weight_grams
        bool is_returnable
        text[] tags
        tsvector search_vector "GENERATED"
        timestamptz deleted_at
    }
    PRODUCT_BOM {
        uuid id PK
        uuid parent_product_id FK
        uuid component_product_id FK
        decimal quantity
        bool is_optional
        int sort_order
    }
    PRODUCT_SPECIFICATION {
        uuid id PK
        uuid product_id FK
        text group_name "Electrical"
        text name "Supply Voltage"
        text value "24"
        text unit "V DC"
        int sort_order
    }
    PRODUCT_MEDIA {
        uuid id PK
        uuid product_id FK
        uuid document_id FK
        enum type "IMAGE|BROCHURE|DATASHEET|MANUAL|CERTIFICATE|VIDEO|CAD"
        bool is_primary
        int sort_order
    }
    PRICE_LIST {
        uuid id PK
        text code UK
        text name
        char currency "INR"
        date valid_from
        date valid_to
        bool is_default
        enum status "DRAFT|ACTIVE|ARCHIVED"
    }
    PRICE_LIST_ITEM {
        uuid id PK
        uuid price_list_id FK
        uuid product_id FK
        uuid variant_id FK
        decimal min_qty "volume slab lower bound"
        decimal price
    }
    DISCOUNT_RULE {
        uuid id PK
        text name
        enum scope "GLOBAL|PRICE_LIST|DISTRIBUTOR|CATEGORY|PRODUCT"
        uuid target_id
        enum type "PERCENT|FLAT"
        decimal value
        decimal min_qty
        decimal min_amount
        int priority
        date valid_from
        date valid_to
        bool is_active
    }
    TAX_RATE {
        uuid id PK
        text hsn_sac_code
        decimal gst_rate
        decimal cess_rate
        date effective_from
        date effective_to
    }
```

Four things worth calling out:

1. **`PRODUCT.type = KIT` + `PRODUCT_BOM`** is what lets a "Raksha IoT — 50 Worker Deployment" be a
   sellable line item that explodes into gateways, tags, licences, and commissioning.
2. **`PRODUCT_SPECIFICATION`** is a proper table, not a JSON blob, because industrial buyers filter
   on specs ("show me DAQ modules with 24 V DC supply") and JSON cannot be indexed for that as
   cheaply.
3. **`TAX_RATE` is date-effective.** When a GST rate changes, we insert a row. Historical invoices
   keep their historical rate. Nothing is edited.
4. **`search_vector` is a generated column** over name, SKU, description and tags, with a GIN index —
   full-text search with zero application-side maintenance.

---

## 5. Inventory — ledger-based

```mermaid
erDiagram
    WAREHOUSE ||--o{ STOCK_LEDGER_ENTRY : records
    WAREHOUSE ||--o{ STOCK_BALANCE : holds
    PRODUCT ||--o{ STOCK_LEDGER_ENTRY : "moves"
    PRODUCT ||--o{ STOCK_BALANCE : "balances"
    PRODUCT ||--o{ BATCH : "lotted as"
    PRODUCT ||--o{ SERIAL_NUMBER : "serialised as"
    ORDER ||--o{ STOCK_RESERVATION : reserves
    STOCK_TRANSFER ||--o{ STOCK_TRANSFER_LINE : contains

    STOCK_LEDGER_ENTRY {
        uuid id PK "IMMUTABLE - append only"
        uuid warehouse_id FK
        uuid product_id FK
        uuid variant_id FK
        uuid batch_id FK
        enum movement_type "RECEIPT|ISSUE|TRANSFER_IN|TRANSFER_OUT|ADJUSTMENT|SALES_RETURN|SCRAP|OPENING"
        decimal quantity "SIGNED: +in / -out"
        decimal unit_cost
        text ref_type "ORDER|SHIPMENT|TRANSFER|ADJUSTMENT"
        uuid ref_id
        timestamptz occurred_at
        uuid created_by_id FK
    }
    STOCK_BALANCE {
        uuid id PK "derived read-model"
        uuid warehouse_id FK
        uuid product_id FK
        uuid variant_id FK
        uuid batch_id FK
        decimal quantity_on_hand "CHECK >= 0"
        decimal quantity_reserved "CHECK >= 0"
        decimal quantity_available "GENERATED on_hand - reserved"
        decimal average_cost
        timestamptz updated_at
    }
    STOCK_RESERVATION {
        uuid id PK
        uuid warehouse_id FK
        uuid product_id FK
        uuid order_id FK
        decimal quantity
        enum status "ACTIVE|RELEASED|CONSUMED|EXPIRED"
        timestamptz expires_at
    }
    SERIAL_NUMBER {
        uuid id PK
        uuid product_id FK
        text serial UK
        enum status "IN_STOCK|RESERVED|SOLD|RMA|SCRAPPED"
        uuid warehouse_id FK
        uuid current_distributor_id FK
        uuid current_customer_id FK
        date warranty_start
        date warranty_end
    }
    INVENTORY_SETTING {
        uuid id PK
        uuid product_id FK
        uuid warehouse_id FK
        decimal reorder_level
        decimal reorder_quantity
        decimal max_level
        bool alert_enabled
    }
```

### Why a ledger and not a counter

A mutable `stock_quantity` column is the single most common source of data corruption in
inventory systems: two concurrent dispatches read 10, both subtract 6, and the column says 4 when
it should say -2. It is unrecoverable because there is no history to reconcile against.

The ledger design instead:

- `STOCK_LEDGER_ENTRY` is **append-only and immutable**. It is the source of truth and a complete
  audit trail. Adjustments are new compensating rows, never edits.
- `STOCK_BALANCE` is a derived read-model updated **in the same transaction** as the ledger, under
  `SELECT … FOR UPDATE` on the balance row. Concurrent movements serialise on that row lock.
- A `CHECK (quantity_on_hand >= 0)` constraint is the final backstop — the database itself refuses
  to hold negative stock even if application logic is bypassed.
- A nightly reconciliation job re-derives every balance from the ledger and alerts on any drift,
  which means a bug is detected in hours rather than discovered in an annual stock count.

`SERIAL_NUMBER` tracks a Raksha IoT device from Hixaa's warehouse to a distributor to a specific
plant, with its warranty window — directly serving the traceability need identified in §1.1 of the
domain study.

---

## 6. Sales — Quotations, Orders, Shipments

```mermaid
erDiagram
    QUOTATION ||--o{ QUOTATION_LINE : contains
    QUOTATION ||--o| ORDER : "converts to"
    ORDER ||--o{ ORDER_LINE : contains
    ORDER ||--o{ ORDER_STATUS_HISTORY : "tracked by"
    ORDER ||--o{ SHIPMENT : "fulfilled by"
    ORDER ||--o{ INVOICE : "billed by"
    SHIPMENT ||--o{ SHIPMENT_LINE : contains
    DISTRIBUTOR ||--o{ ORDER : places
    CUSTOMER ||--o{ ORDER : "receives secondary"

    ORDER {
        uuid id PK
        text order_number UK "SO-2627-00118"
        enum type "PRIMARY|SECONDARY"
        uuid distributor_id FK
        uuid customer_id FK "secondary only"
        enum status "DRAFT|PENDING_APPROVAL|APPROVED|PROCESSING|PARTIALLY_DISPATCHED|DISPATCHED|DELIVERED|COMPLETED|CANCELLED|REJECTED"
        text customer_po_number
        date customer_po_date
        uuid price_list_id FK
        uuid billing_address_id FK
        uuid shipping_address_id FK
        uuid place_of_supply_state_id FK
        date order_date
        date expected_delivery_date
        decimal subtotal
        decimal discount_total
        decimal taxable_amount
        decimal cgst_amount
        decimal sgst_amount
        decimal igst_amount
        decimal cess_amount
        decimal round_off
        decimal grand_total
        uuid approved_by_id FK
        timestamptz approved_at
        text cancellation_reason
    }
    ORDER_LINE {
        uuid id PK
        uuid order_id FK
        int line_no
        uuid product_id FK
        uuid variant_id FK
        text description "snapshot"
        text hsn_sac_code "snapshot"
        uuid uom_id FK
        decimal quantity
        decimal unit_price "snapshot"
        decimal discount_percent
        decimal discount_amount
        decimal taxable_value
        decimal gst_rate "snapshot"
        decimal cgst_amount
        decimal sgst_amount
        decimal igst_amount
        decimal line_total
        decimal dispatched_qty
        decimal cancelled_qty
    }
    SHIPMENT {
        uuid id PK
        text shipment_number UK
        uuid order_id FK
        uuid warehouse_id FK
        enum status "PENDING|PACKED|DISPATCHED|IN_TRANSIT|DELIVERED|RETURNED"
        text carrier_name
        text tracking_number
        text vehicle_number
        text lr_number
        text eway_bill_number
        timestamptz dispatched_at
        timestamptz delivered_at
        text received_by_name
        uuid pod_document_id FK
    }
```

**Every price, rate, description and HSN code on an `ORDER_LINE` is a snapshot**, deliberately
denormalised. If a product is renamed or repriced next year, a historical order must still print
exactly what was agreed. Joining live catalog data into a historical document is a classic and
expensive mistake.

---

## 7. Finance — Invoices, Payments, Ledger, Tax

```mermaid
erDiagram
    INVOICE ||--o{ INVOICE_LINE : contains
    INVOICE ||--o{ PAYMENT_ALLOCATION : "settled by"
    PAYMENT ||--o{ PAYMENT_ALLOCATION : allocates
    INVOICE ||--o{ LEDGER_ENTRY : debits
    PAYMENT ||--o{ LEDGER_ENTRY : credits
    INVOICE ||--o| INVOICE : "credit note against"
    NUMBER_SEQUENCE ||--o{ INVOICE : numbers

    INVOICE {
        uuid id PK
        text invoice_number UK "gapless, per FY"
        enum type "TAX_INVOICE|PROFORMA|CREDIT_NOTE|DEBIT_NOTE"
        uuid against_invoice_id FK "for CN/DN"
        uuid order_id FK
        uuid distributor_id FK
        uuid customer_id FK
        date invoice_date
        date due_date
        enum supply_type "B2B|B2C|SEZ|EXPORT"
        uuid place_of_supply_state_id FK
        bool is_reverse_charge
        text seller_gstin
        text buyer_gstin
        decimal taxable_value
        decimal cgst_amount
        decimal sgst_amount
        decimal igst_amount
        decimal cess_amount
        decimal round_off
        decimal grand_total
        decimal amount_paid
        decimal amount_due
        enum status "DRAFT|ISSUED|PARTIALLY_PAID|PAID|OVERDUE|CANCELLED"
        text irn "e-Invoice, v2 hook"
        text ack_number
        text qr_code_payload
        uuid pdf_document_id FK
    }
    PAYMENT {
        uuid id PK
        text payment_number UK
        enum direction "INBOUND|OUTBOUND"
        uuid distributor_id FK
        uuid customer_id FK
        enum method "NEFT|RTGS|IMPS|UPI|CHEQUE|DD|CASH|ADJUSTMENT"
        decimal amount
        decimal tds_amount
        date payment_date
        text reference_number
        text bank_name
        enum status "PENDING|CLEARED|BOUNCED|CANCELLED"
        uuid proof_document_id FK
        uuid recorded_by_id FK
        uuid verified_by_id FK
        timestamptz verified_at
    }
    PAYMENT_ALLOCATION {
        uuid id PK
        uuid payment_id FK
        uuid invoice_id FK
        decimal amount
    }
    LEDGER_ENTRY {
        uuid id PK "append only"
        enum party_type "DISTRIBUTOR|CUSTOMER"
        uuid party_id
        date entry_date
        enum ref_type "OPENING|INVOICE|PAYMENT|CREDIT_NOTE|DEBIT_NOTE|ADJUSTMENT"
        uuid ref_id
        decimal debit
        decimal credit
        decimal running_balance
        text narration
    }
    NUMBER_SEQUENCE {
        uuid id PK
        text key UK "INVOICE:2026-27"
        text prefix
        int next_value
        int padding
        text financial_year
        enum reset_policy "NEVER|YEARLY|MONTHLY"
    }
```

### Three deliberate design choices here

1. **`PAYMENT_ALLOCATION` is a join table with an amount**, not a foreign key from payment to
   invoice. Real distributors pay ₹5,00,000 against four invoices at once, or part-pay one. A
   one-to-one link cannot express that and forces users into fictional data entry.
2. **`LEDGER_ENTRY` is the truth for outstanding balances.** Aging buckets, statements of account,
   and credit checks all read from it. There is no mutable `outstanding` column to drift.
3. **`NUMBER_SEQUENCE` allocates inside the invoice transaction** with `SELECT … FOR UPDATE`.
   Under Indian GST, gaps in an invoice series invite scrutiny; generating numbers optimistically
   in application code produces gaps whenever a transaction rolls back.

### GST computation rule (implemented in `GstCalculator`, tested exhaustively)

```
supplier_state = Hixaa's GSTIN state (27 — Maharashtra)
place_of_supply = ORDER.place_of_supply_state_id  (buyer's shipping state, per §10 IGST Act)

if supplier_state == place_of_supply:   CGST = SGST = rate/2   ; IGST = 0
else:                                   IGST = rate            ; CGST = SGST = 0

Rounding: per line, half-up to 2 decimals. Invoice round_off absorbs the residual
so that grand_total is a whole rupee.
```

---

## 8. Customers, Documents, Notifications, Ops

```mermaid
erDiagram
    CUSTOMER ||--o{ CUSTOMER_CONTACT : has
    CUSTOMER ||--o{ ORDER : "buys via secondary"
    INDUSTRY ||--o{ CUSTOMER : classifies
    DOCUMENT ||--o{ DOCUMENT_LINK : "attached via"
    USER ||--o{ NOTIFICATION : receives
    OUTBOX_EVENT }o--|| SYNC_JOB : "may trigger"

    CUSTOMER {
        uuid id PK
        text code UK
        text name
        enum type "INDUSTRIAL|GOVERNMENT|OEM|INSTITUTIONAL|INDIVIDUAL"
        uuid industry_id FK "Thermal Power, Coal, Mining, Cement, Rail"
        uuid distributor_id FK "owning channel partner, null if direct"
        uuid territory_id FK
        text gstin
        text pan
        enum status "PROSPECT|ACTIVE|INACTIVE"
    }
    DOCUMENT {
        uuid id PK
        text storage_key UK
        enum provider "LOCAL|S3"
        text original_name
        text mime_type
        bigint size_bytes
        text checksum_sha256
        enum scan_status "PENDING|CLEAN|INFECTED|SKIPPED"
        enum visibility "PUBLIC|INTERNAL|RESTRICTED"
        uuid uploaded_by_id FK
        timestamptz deleted_at
    }
    DOCUMENT_LINK {
        uuid id PK
        uuid document_id FK
        text entity_type
        uuid entity_id
        text purpose
    }
    OUTBOX_EVENT {
        uuid id PK
        text aggregate_type
        uuid aggregate_id
        text event_type "order.approved"
        jsonb payload
        enum status "PENDING|PROCESSING|PROCESSED|FAILED|DEAD"
        int attempts
        timestamptz available_at
        timestamptz processed_at
        text last_error
    }
    SYNC_JOB {
        uuid id PK
        enum entity "USERS|PRODUCTS|DISTRIBUTORS|ORDERS|PAYMENTS|INVENTORY"
        enum mode "SCHEDULED|MANUAL"
        enum direction "EXPORT|RESTORE"
        text spreadsheet_id
        text sheet_name
        int rows_processed
        enum status "QUEUED|RUNNING|SUCCESS|FAILED|PARTIAL"
        text checkpoint_cursor
        text error
    }
    EMAIL_LOG {
        uuid id PK
        enum channel "BUSINESS|OPS"
        citext to_address
        text subject
        text template
        enum status "QUEUED|SENT|FAILED|BOUNCED"
        text provider_message_id
        int attempts
        text error
    }
```

Also here: `SYSTEM_SETTING` (jsonb, category-keyed — holds the company profile, branding, portfolio
content, and feature flags so the Admin Panel can edit them), `NOTIFICATION`,
`NOTIFICATION_PREFERENCE`, `SAVED_REPORT`, `REPORT_RUN`, `SCHEDULED_REPORT`, `FEATURE_FLAG`.

**`SYSTEM_SETTING` is how we honour "do not hardcode portfolio data."** Company name, address,
GSTIN, logo, service lines, and industries are seeded rows, editable from Settings, cached in Redis.

---

## 9. Index strategy

Indexes are designed with the queries, not bolted on after a slow-query report.

| Table | Index | Serves |
|---|---|---|
| `user` | `UNIQUE (lower(email)) WHERE deleted_at IS NULL` | Login; case-insensitive uniqueness |
| `session` | `(refresh_token_hash)`, `(user_id, revoked_at)`, `(family_id)` | Refresh rotation + reuse detection |
| `distributor` | `(status, territory_id)`, `(account_manager_id)`, GIN `(search_vector)`, `UNIQUE (gstin) WHERE gstin IS NOT NULL` | Scoped lists, search, GST uniqueness |
| `product` | GIN `(search_vector)`, `(category_id, status)`, `(status, created_at DESC, id DESC)` | Catalog browse, search, keyset pagination |
| `product` | GIN `(tags)`, `gin_trgm_ops (name)` | Tag filter, fuzzy/typo search |
| `stock_balance` | `UNIQUE (warehouse_id, product_id, variant_id, batch_id)` | The row lock target |
| `stock_balance` | `(product_id) WHERE quantity_available <= 0` (partial) | Out-of-stock dashboards, tiny index |
| `stock_ledger_entry` | `(warehouse_id, product_id, occurred_at DESC)`, `(ref_type, ref_id)` | Movement history, reconciliation |
| `order` | `(distributor_id, status, order_date DESC)`, `(status, expected_delivery_date)` | Distributor 360, fulfilment queue |
| `order` | `(order_date DESC, id DESC)` | Keyset pagination |
| `order_line` | `(order_id, line_no)`, `(product_id, created_at)` | Line fetch, product performance |
| `invoice` | `(distributor_id, status)`, `(status, due_date) WHERE status <> 'PAID'` (partial) | Aging & overdue — the hot finance query |
| `ledger_entry` | `(party_type, party_id, entry_date DESC)` | Statement of account |
| `audit_log` | `(entity_type, entity_id, created_at DESC)`, `(actor_user_id, created_at DESC)` | Entity history, user activity |
| `outbox_event` | `(status, available_at) WHERE status IN ('PENDING','FAILED')` (partial) | The dispatcher's poll — stays small forever |

**Partial indexes are used deliberately.** `invoice(status, due_date) WHERE status <> 'PAID'`
indexes only open invoices — a few thousand rows instead of millions — and it is the query the
finance team runs constantly.

---

## 10. Partitioning & retention

| Table | Strategy |
|---|---|
| `audit_log` | `PARTITION BY RANGE (created_at)`, monthly. Partitions older than 24 months detached to cold storage after Sheets/dump backup |
| `stock_ledger_entry` | Monitored; partition by year once past ~50M rows. Schema is partition-ready from day one |
| `email_log`, `outbox_event` | Processed rows purged after 90 days by a maintenance job |
| `session` | Expired rows purged nightly |

---

## 11. Migration & seed policy

- **Migrations are forward-only** and reviewed like code. Destructive changes (drop column, narrow
  type) require an explicit two-release expand/contract: add → backfill → switch reads → drop.
- **`prisma migrate deploy` runs as a one-shot container** before the API starts, never on app boot
  in parallel replicas.
- **Seeds are idempotent** (`upsert` on natural keys) and split:
  - `seed:system` — permissions, roles, GST state codes, UOMs, number sequences. Runs in production.
  - `seed:portfolio` — Hixaa company profile, service-line categories, industries, and the
    Raksha IoT product with its real specifications. Runs in production.
  - `seed:demo` — synthetic distributors, orders, payments for development. **Never in production**,
    guarded by `NODE_ENV`.
