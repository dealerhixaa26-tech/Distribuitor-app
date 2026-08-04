# 12 — Recommendations & Trade-offs

> You asked me to recommend improvements first, explain the trade-offs, and implement only after
> approval. This is that list. **Nothing here is built yet.**
>
> Grouped by whether I think you should say yes. Each has a cost so you can decide, not just agree.

---

## A. Strongly recommended — I would not build this system without them

### A1. Ledger-based inventory instead of a stock counter
**What:** `StockLedgerEntry` is append-only; `StockBalance` is a derived read-model updated under a
row lock in the same transaction, with a `CHECK (quantity_on_hand >= 0)` constraint.
**Why:** A mutable `stock_quantity` column corrupts silently under concurrency — two dispatches read
10, both subtract 6, the column says 4 instead of -2, and there is no history to reconcile against.
**Cost:** ~1.5 extra days in Phase 6, one extra table, a nightly reconciliation job.
**Trade-off:** Slightly more complex writes. Reads are unaffected (they hit the balance table).
**Recorded as:** ADR-0002.

### A2. `Money` as `DECIMAL(18,4)` + a value object; money as **strings** in JSON
**What:** No `float`/`number` for currency anywhere, including over the wire.
**Why:** `0.1 + 0.2 !== 0.3`. On a ₹48,75,000 invoice, JSON's IEEE-754 doubles round in ways that
make an invoice disagree with a payment allocation by a few paise — which in a GST audit is a real
problem, not a cosmetic one.
**Cost:** Callers must use `Money.add()` rather than `+`. Frontend parses strings for display.
**Trade-off:** Marginally more verbose. Non-negotiable in my view.
**Recorded as:** ADR-0004.

### A3. Scoped RBAC from day one
**What:** `UserRole.scopeType/scopeId` plus a Prisma extension that injects the scope predicate into
every query, so forgetting to filter is impossible.
**Why:** The Distributor Portal is coming. Retrofitting row-level scoping onto ~200 existing query
sites is where authorization holes are born — you will miss one, and a distributor will see another
distributor's pricing.
**Cost:** ~2 days in Phase 2. Essentially zero later.
**Trade-off:** A little indirection in the repository layer.
**Recorded as:** ADR-0003.

### A4. Transactional outbox for all side effects
**What:** Services write an `OutboxEvent` inside the business transaction; a dispatcher worker
publishes to BullMQ after commit.
**Why:** Directly satisfies *"never slow down API requests because of Google Sheets"* — and prevents
the inverse failure, where an email announces an order whose transaction rolled back.
**Cost:** ~1 day in Phase 1, one table, one worker loop.
**Recorded as:** ADR-0005.

### A5. `pg_dump` as the real backup; Google Sheets as a convenience copy
**What:** Build the Sheets backup exactly as you specified, **and** nightly encrypted `pg_dump` with
a rehearsed restore.
**Why, plainly:** Google Sheets caps at 10 million cells per spreadsheet. At 1M+ products, a single
sheet cannot hold your data, and Sheets has no transactional consistency, no foreign keys, and no
point-in-time recovery. It is excellent for human inspection and a quick eyeball of yesterday's
orders. It is not a disaster-recovery mechanism, and I would be doing you a disservice to let it
look like one.
**Cost:** ~half a day (a shell script and a cron entry).
**Trade-off:** None. The Sheets sync is still built as specified.

### A6. Full GST correctness — including the invoice-numbering detail
**What:** Gapless per-financial-year invoice numbers allocated inside the transaction with
`SELECT … FOR UPDATE`, plus immutable issued invoices corrected only by credit note.
**Why:** Gaps in a GST invoice series attract scrutiny. Numbers generated optimistically in
application code produce a gap every time a transaction rolls back.
**Cost:** Already in the plan; noted so the reasoning is visible.

---

## B. Recommended — clear value, modest cost

### B1. Quotation / RFQ module *(added to the roadmap, Phase 7.1)*
**What:** RFQ → Quotation → Order, with a PDF and a validity window.
**Why:** Your website's primary call to action is *Request for Quotation*. A DMS for a
solutions business that starts at "order" skips the step where the actual selling happens, and your
team would keep quoting in Excel.
**Cost:** ~3 days. Reuses the order pricing engine and PDF pipeline almost entirely.
**Ask:** Confirm you want this in v1. I have included it; say the word and I will drop it.

### B2. Serial-number tracking with warranty windows
**What:** `SerialNumber` with a full trace: warehouse → distributor → customer → warranty end.
**Why:** Raksha IoT is a **worker-safety** device. When a unit fails in a confined space, "which
unit, sold when, to whom, still under warranty?" is a question you will need answered in minutes,
possibly under liability pressure.
**Cost:** ~2 days in Phase 6.
**Trade-off:** Adds a step to receipt and dispatch for serialised products. Optional per product
via `isSerialized`.

### B3. Product BOM / kits
**What:** `PRODUCT.type = KIT` with a component list that explodes on order.
**Why:** A Raksha IoT deployment is gateways + tags + licences + commissioning, not one SKU. Without
BOM, your team hand-enters five lines every time and stock never reconciles.
**Cost:** ~2 days in Phase 4.

### B4. `PaymentAllocation` (one payment across many invoices)
**What:** A join table with an amount instead of a payment→invoice foreign key.
**Why:** Distributors pay ₹5,00,000 against four invoices, or part-pay one. A one-to-one link forces
your accounts team to invent fictional data entry, and the aging report becomes fiction with it.
**Cost:** Trivial — one table, and it is the correct model.

### B5. Idempotency keys on order and payment endpoints
**What:** `Idempotency-Key` header; replays return the stored response.
**Why:** A distributor on patchy 4G taps "Place order", the request times out, they tap again. Two
orders, two reservations, one angry phone call.
**Cost:** ~half a day, one table.

### B6. Approval ceilings with escalation
**What:** Configurable discount and order-value limits per role, escalating rather than failing.
**Why:** Your prompt asked for approvals; without ceilings, "approval" is a single binary that either
blocks everything or nothing.
**Cost:** ~1 day. Configurable in Settings, not compiled in.

---

## C. Worth considering — genuine trade-offs, your call

### C1. Staging environment on the same VPS
**Pro:** Test migrations and releases against real-shaped data before production. Prevents the class
of incident where a migration works on an empty dev DB and fails on production data.
**Con:** ~1.5 GB additional RAM. Needs an 8 GB plan rather than 4 GB.
**My view:** Worth it. The first migration that would have broken production pays for it.

### C2. Soft-delete everywhere vs. archive-only for financial documents
**Current design:** Soft delete on masters; financial documents are **cancelled, never deleted**.
**Alternative:** Hard delete on masters with an archive table.
**My view:** Keep the current design. Simpler and adequate.

### C3. Multi-tenancy scaffolding now
**What:** An `organizationId` on every table, ready for Hixaa to run this as a product for other
companies later.
**Pro:** Retrofitting tenancy is a very large migration.
**Con:** Adds a column and a predicate to every query for a need that may never arrive, and it
complicates every index.
**My view:** **Skip it.** The scoped-RBAC layer (A3) already gives you 80% of the isolation
machinery, and if Hixaa ever productises this, that layer is where tenancy would attach. Building
for an imagined second customer is the most common way good schemas get worse.

### C4. Event sourcing for orders
**My view:** **No.** `OrderStatusHistory` plus the audit log gives you the timeline and the
attribution you actually want, at a fraction of the complexity. Event sourcing here would be
architecture for its own sake.

### C5. Recharts vs. a heavier charting library
**Current:** Recharts, as you specified. Adequate for the dashboards described.
**Watch item:** If regional sales needs a genuine India map with district-level drill-down, Recharts
will not do it and we would add `visx` or a lightweight GeoJSON renderer for that one view.
**My view:** Start with Recharts. Revisit only if a specific chart demands it.

---

## D. Things I am deliberately **not** recommending

Named so you know they were considered and rejected, rather than overlooked.

| Idea | Why not |
|---|---|
| **Microservices** | One team, one deployment target, one database. A modular monolith with clean module boundaries gives you the same separation with none of the distributed-transaction pain. If a module ever needs to scale independently, its boundaries are already clean enough to extract |
| **GraphQL** | The clients are known and the access patterns are stable. REST + OpenAPI gives better caching, simpler auth, and far simpler rate limiting. GraphQL would add a query-cost problem you do not currently have |
| **Kubernetes** | One VPS. Compose is the right tool and can be understood in full by one person at 2 a.m. |
| **Elasticsearch in v1** | Postgres FTS with `tsvector` + `pg_trgm` handles millions of rows comfortably. Adding a second datastore means a second thing to back up, secure, and keep in sync |
| **A separate distributor database** | Would break the single-backend requirement and double the schema. Scoped RBAC solves this properly |
| **`class-validator` DTOs alongside Zod** | Two schema definitions that can disagree. `nestjs-zod` gives validation *and* OpenAPI from the single contract |
| **Server-side rendering of every table page** | Tables are interactive and filtered; RSC for the shell plus client-side data fetching is faster in practice and simpler to reason about |

---

## E. Open questions I need you to answer before Phase 3 and Phase 8

These do not block Phase 1 or 2, so implementation can begin immediately after approval. I will need
them by the phase noted.

| # | Question | Needed by | Default if unanswered |
|---|---|---|---|
| E1 | Hixaa's **GSTIN, PAN, and CIN** for invoice generation | Phase 8 | Placeholder, invoices marked `DRAFT-ONLY` |
| E2 | **Invoice number format** — e.g. `HTPL/26-27/0001`? Any format your CA has mandated? | Phase 8 | `HTPL/INV/26-27/00001` |
| E3 | **Warehouse list** — how many physical locations, and where? | Phase 6 | One: Nagpur |
| E4 | **Territory structure** — how does Hixaa actually divide India for sales? | Phase 3 | Zone → State → District, 4 zones |
| E5 | **Hostinger VPS plan** (RAM/vCPU) and whether Docker is already installed | Phase 11 | Assumes 8 GB / 4 vCPU |
| E6 | **Domain** for the DMS — `dms.hixaa.com`? | Phase 11 | `dms.hixaa.com` |
| E7 | **Google Cloud service account** for the Sheets API — do you have one, or shall I document the setup steps? | Phase 10 | I will write the setup guide |
| E8 | **Real product/price data** — can you export what exists today (Excel/Tally), or do we start from the catalog UI? | Phase 4 | Start from the UI; import tool built regardless |
| E9 | **Payment terms** actually used — Net 30? Net 45? Advance? | Phase 5 | Net 30, Net 45, Advance, COD |
| E10 | Company **logo** in SVG and the exact brand hex values | Phase 1 | Deep industrial blue `#0057B8` placeholder |

---

## F. What I need from you now

1. **Approve or amend the architecture** (`01`), **the schema** (`02`), and **the roadmap** (`05`).
2. **Confirm section A** — I consider these five load-bearing.
3. **Accept or drop each item in section B** — particularly B1 (quotations), which I have already
   placed in the roadmap.
4. **Decide C1** (staging on the same VPS) — it affects the VPS plan you buy.
5. Answer **E1–E10** when convenient; only E10 touches Phase 1.

On approval I begin **Phase 1 — Foundation**, and will report at each module gate rather than
disappearing into a large unreviewable change.
