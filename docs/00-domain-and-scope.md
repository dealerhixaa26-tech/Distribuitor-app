# 00 — Domain Study, Scope & Glossary

> Phase 0 deliverable. Read this before `01-architecture.md`.
> Status: **Awaiting approval**

---

## 1. The company we are building for

**Hixaa Technologies Pvt. Ltd.** — Nagpur, Maharashtra (office also in Pune). ~20+ consultants and
engineers. Tagline: *"Excellence In Automation" / "Powerful Automation Solutions"*.

Sourced from the company portfolio ([hixaa.com](https://hixaa.com),
[products](https://hixaa.com/products/), [services](https://hixaa.com/services/),
[LinkedIn](https://in.linkedin.com/company/hixaa)):

| Dimension | Values (seeded into DB, never hardcoded) |
|---|---|
| **Service lines** | Industrial Automation, Internet of Things (IIoT), Embedded Systems, System Integration (LabVIEW), Machine Vision, Computer Vision, PCB Designing, Data Acquisition Systems, Automated Test Equipment, Test Bench, Wireless Controlling & Monitoring, Robotics, Industrial Training, Product Engineering, OEM Solutions |
| **Flagship product** | **Raksha IoT** — *"Your Safety Guardian in Confined Spaces"*. Worker safety / confined-space entry monitoring for boiler maintenance. Real-time worker tracking, automated entry–exit logging, authorised-worker verification, live hazard alerts, bulk employee registration, report generation. |
| **Industries served** | Thermal Power Plants, Coal, Mining (underground & open-cast), Cement, Train/Rail Simulation |
| **Key technologies** | NI LabVIEW, Industry 4.0, Machine Vision, Computer Vision, Python, long/short-range wireless, DAQ, rapid prototyping / additive manufacturing |
| **Commercial motion** | Request for Quotation (RFQ) driven; Vendor Registration |
| **Registered address** | Yogeshwar, Plot #26B, Anmol Nagar, Behind Santaji Nursing Home, Wathoda Square, Nagpur, Maharashtra 440035 |
| **Contact** | info@hixaa.com · +91-9372429144 · +91-9860013298 |

### 1.1 The single most important observation

**Hixaa is a solutions and projects business, not an FMCG business.**

Most DMS products on the market assume a fast-moving catalog of thousands of identical
low-value SKUs moving through a channel in high volume. Hixaa's reality is the opposite:

- A small number of high-value line items (a test bench, an ATE rig, a machine-vision cell).
- Systems **assembled from components** — a Raksha IoT deployment is gateways + wearable tags +
  a server licence + commissioning + AMC, not one SKU.
- **Service line items** sit alongside goods on the same invoice (commissioning, calibration,
  LabVIEW driver development, training, annual maintenance contracts). These carry **SAC** codes,
  not HSN codes, and are taxed differently.
- **Serial-number traceability matters** — an IoT safety device deployed in a confined space is a
  warranty and liability object. We must know which serial went to which distributor, to which
  end customer, in which plant.
- Sales start as an **RFQ → Quotation**, not as a reorder.

Every design decision below follows from this. A flat SKU catalog would be architecturally wrong
for this company, so the catalog supports `GOODS | SERVICE | KIT | CONFIGURABLE` product types with
a bill of materials, technical specification sheets, and serial/batch tracking.

---

## 2. What we are building

**The Hixaa Admin Portal** — the internal control plane, used by Hixaa employees.

A **Distributor Portal** will be built later as a *separate frontend consuming the same backend*.
This is not a vague aspiration; it is a hard architectural constraint that shapes the auth and
authorization design from commit one (see `04-rbac-and-permissions.md` and ADR-0003). Any query
that returns data must be scope-aware **now**, so that later we only add a UI, not a security model.

### 2.1 Confirmed scope decisions

These four were confirmed before design began:

| Decision | Choice | Consequence |
|---|---|---|
| **Channel depth** | Sell-in **and** sell-out | Two order ledgers (`PRIMARY`, `SECONDARY`), an `Customer` domain, and distributor stock derived rather than self-reported |
| **Tax** | Full GST engine | HSN/SAC, place-of-supply driven CGST/SGST/IGST split, reverse charge, credit/debit notes, GSTR-1/3B export, e-Invoice & e-Way Bill **adapter hooks** (no live GSP integration in v1) |
| **Pricing** | Versioned price lists + volume tiers | `PriceList` / `PriceListItem` / `DiscountRule`, per-order manual discount behind approval |
| **Deployment** | Docker Compose on Hostinger VPS | Compose is the primary and only supported path; local dev and prod share images |

### 2.2 Explicitly out of scope for v1

Named here so scope creep is a visible decision rather than a silent drift:

- Distributor-facing portal UI (backend is prepared for it; UI is v2)
- Multi-currency (INR only — but `currency` columns exist so v2 is a data change, not a schema change)
- Live e-Invoice IRN / e-Way Bill API calls to the NIC/GSP (interfaces and DB fields exist; the
  adapter is a stub that records intent)
- Manufacturing / production planning, purchase-to-pay from Hixaa's own vendors
- Mobile applications (the API is the contract they will consume)
- SMS / WhatsApp notifications (the `NotificationChannel` abstraction makes these a new adapter)
- Elasticsearch / Meilisearch (Postgres FTS now, behind a `SearchProvider` interface)

---

## 3. Actors

| Actor | Description | Portal |
|---|---|---|
| **Super Admin** | Owns the system. Manages roles, settings, integrations. | Admin |
| **Admin** | Day-to-day platform administration, user management. | Admin |
| **Sales Manager** | Owns a territory. Approves orders and discounts within limits. | Admin (territory-scoped) |
| **Sales Executive** | Creates quotations and orders, manages assigned distributors. | Admin (scoped) |
| **Inventory Manager** | Warehouses, stock movements, transfers, adjustments, dispatch. | Admin |
| **Finance Manager** | Invoices, payments, credit limits, credit notes, GST returns. | Admin |
| **Accounts Executive** | Records payments; cannot approve or verify them. | Admin |
| **Support Agent** | Read-heavy; reads distributor and order data for query resolution. | Admin |
| **Auditor** | Read-only across the system, including audit logs. Cannot mutate anything. | Admin |
| **Distributor Owner** | *(v2)* Sees only their own distributor's data. | Distributor |
| **Distributor Staff** | *(v2)* Further restricted subset. | Distributor |
| **System** | Background workers, scheduled jobs. Acts with an explicit system principal so audit logs are never anonymous. | — |

---

## 4. Core business processes (the flows the software must make correct)

### 4.1 Distributor onboarding
```
Lead → Pending Approval → (KYC docs verified: GST cert, PAN, agreement, cancelled cheque)
     → Active → [Suspended] → Terminated
```
A distributor cannot transact until `ACTIVE`. Credit limit and payment terms are set at approval.

### 4.2 Order to cash (primary / sell-in)
```
RFQ → Quotation → (accepted) → Order (DRAFT)
    → credit check + discount approval → APPROVED
    → stock reserved → PROCESSING
    → Shipment(s) created, stock issued → PARTIALLY_DISPATCHED / DISPATCHED
    → POD captured → DELIVERED
    → Tax Invoice issued (gapless statutory number) → Payment(s) allocated → COMPLETED
```

**Invariants** — the system must never violate these:
1. A distributor cannot exceed `creditLimit` unless a Finance Manager overrides, and the override
   is audited.
2. Stock cannot be dispatched that is not on hand and reserved for that order.
3. An issued tax invoice is **immutable**. Corrections happen via credit/debit note, never by edit.
4. Invoice numbers are gapless and reset per Indian financial year (1 Apr – 31 Mar).
5. `sum(PaymentAllocation.amount) <= Invoice.grandTotal` at all times.
6. Stock on hand for a (warehouse, product) can never go negative.

### 4.3 Secondary sales (sell-out)
Distributor reports a sale to an end customer. This decrements **distributor** warehouse stock,
creates a `SECONDARY` order against a `Customer`, and feeds channel-inventory and
sell-through analytics. In v1 an admin records it; in v2 the distributor self-serves through the
portal — the same endpoint, a different scope.

### 4.4 Money
```
Invoice → LedgerEntry(debit)
Payment → LedgerEntry(credit) → PaymentAllocation → Invoice.amountDue recalculated
Outstanding = running balance; aged into 0–30 / 31–60 / 61–90 / 90+ buckets
```
A double-entry-style `LedgerEntry` table is the source of truth for "what does this distributor owe
us", not a mutable `balance` column. Balances derived from an append-only ledger cannot silently
drift.

---

## 5. Glossary

Shared language between the code, the database, and this documentation. Where the industry has two
words for one thing, the left column is the one the codebase uses.

| Term | Meaning |
|---|---|
| **Primary sale / sell-in** | Hixaa → Distributor. `Order.type = PRIMARY` |
| **Secondary sale / sell-out** | Distributor → End Customer. `Order.type = SECONDARY` |
| **Distributor** | Any channel partner: distributor, dealer, system integrator, OEM partner |
| **Customer** | An end customer (a plant, a mine, a government body) |
| **Territory** | A hierarchical sales geography: Zone → Region → State → District |
| **Price list** | A named, date-effective set of prices assigned to distributors |
| **HSN** | Harmonised System of Nomenclature — tax code for **goods** |
| **SAC** | Services Accounting Code — tax code for **services** |
| **Place of supply** | The state that determines whether GST splits into CGST+SGST (intra-state) or is charged as IGST (inter-state) |
| **GSTIN** | 15-character GST identification number; characters 1–2 encode the state |
| **UQC** | Unit Quantity Code — the GST-mandated unit code (NOS, KGS, SET…) |
| **Stock ledger** | The immutable, append-only record of every stock movement |
| **Stock balance** | A derived read-model of the ledger, kept in the same transaction |
| **Reservation** | Stock committed to an approved order but not yet physically issued |
| **Available quantity** | `onHand − reserved` |
| **Outbox** | The transactional table that guarantees side effects (email, Sheets sync) happen exactly once, after commit |
| **Scope** | The data boundary attached to a role assignment: `GLOBAL`, `TERRITORY`, or `DISTRIBUTOR` |
| **DUT** | Device Under Test — Hixaa terminology from the ATE service line |
| **AMC** | Annual Maintenance Contract — a recurring service SKU |
| **RFQ** | Request for Quotation — how Hixaa's sales motion begins |

---

## 6. Non-functional requirements

| Requirement | Target | How it is met |
|---|---|---|
| Scale | 100k+ distributors, 1M+ products, 10M+ order lines | Keyset pagination, covering indexes, partitioned audit log, materialised views for dashboards |
| API latency | p95 < 300 ms for list endpoints, p99 < 800 ms | No N+1 (explicit `select`), Redis caching of reference data, no synchronous third-party calls |
| Dashboard load | < 1.5 s | Pre-aggregated materialised views refreshed by worker, never live `GROUP BY` over raw orders |
| Availability | Single VPS; graceful degradation | Redis/Sheets/email failures must never fail a business request — all are async via outbox |
| Security | OWASP Top 10 (2021) | See `06-security.md` |
| Accessibility | WCAG 2.2 AA | Radix primitives via shadcn/ui, focus management, contrast tokens, keyboard-first |
| Auditability | Every mutation attributable | `AuditLog` with before/after JSON, actor, IP, request ID |
| RPO / RTO | RPO 24h (Sheets) + 1h (pg_dump); RTO < 2h | Nightly encrypted dumps + Google Sheets backup + documented restore drill |

---

## 7. Risks identified up front

| Risk | Impact | Mitigation |
|---|---|---|
| GST rules change (rates, e-Invoice thresholds) | Legal exposure | Tax rates are date-effective **data**, not code. `TaxRate.effectiveFrom` |
| Invoice number gaps | GST notice | Gapless sequence allocated inside the DB transaction with `SELECT … FOR UPDATE` |
| Google Sheets API quota / outage | Backup silently stops | Backups are jobs with status + alerting to the ops mailbox; failures page loudly and never block requests |
| Single VPS is a single point of failure | Downtime | Documented restore, nightly off-box backups, and a deliberately boring stack that can be rebuilt from Compose |
| Concurrent dispatch oversells stock | Negative stock, angry customer | Row-level locks on `StockBalance` + a `CHECK (quantity_on_hand >= 0)` constraint as the last line of defence |
| Scope creep into full ERP | Never ships | This document's §2.2, and a roadmap with explicit module gates |

---

## 8. Sources

- <https://hixaa.com/>
- <https://hixaa.com/products/>
- <https://hixaa.com/services/>
- <https://hixaa.com/about-us/>
- <https://in.linkedin.com/company/hixaa>
