# 18 — Phase 4 Completion: Catalog & Pricing

> Design: `17-phase-4-design.md`. ADRs: **0007** (pricing pipeline), **0008** (GST-exclusive basis).
> Status: **complete and verified by execution.**

---

## 1. What was built

| # | Module | State |
|---|---|---|
| 4.1 | Categories & brands | ✅ Nested tree, materialised path, cycle-guarded reparenting |
| 4.2 | Products | ✅ Four types, specifications as rows, media, revisions, FTS + typo tolerance |
| 4.3 | BOM / kits | ✅ Recursive explosion, cycle-guarded, quantity-multiplied |
| 4.4 | Price lists | ✅ Versioned, date-effective, volume slabs, clone & publish |
| 4.5 | Discount rules | ✅ Priority resolution, no stacking, `POST /pricing/quote` |
| 4.6 | Tax | ✅ Date-effective `TaxRate`, `GstCalculator`, property-tested |

**Both Phase 5 seams are closed.** `Distributor.priceListId` is now a real FK with
`onDelete: Restrict`; `DistributorProduct` is the authorized catalog and is scope-enforced.

### Numbers

| | Before Phase 4 | After |
|---|---|---|
| Source lines | ~20,500 | ~26,600 |
| Tables | 36 | **50** |
| Migrations | 5 | **6** |
| Endpoints (OpenAPI) | 69 | **112** |
| Tests | — | **232** (107 contracts + 125 API) |

`pnpm verify` green: lint (5 pre-existing warnings, 0 errors), typecheck, tests, build.

---

## 2. The two decisions taken with the owner

**E8 — existing data to import.** Answer: *"i have the company portfolio add the products and make
it such that its price can be changed according to situation."*

There is no Excel or Tally export. The catalog is therefore seeded from the company portfolio that
`prisma/seed/portfolio.seed.ts` already staged — that file's own header anticipated this phase, so
`catalog.seed.ts` **imports `HIXAA_SERVICE_LINES` and `RAKSHA_IOT` from it** rather than re-listing
them. The published services and the category tree cannot drift apart.

No CSV importer was built. Building an importer for a format nobody has produces untested code
shaped by guesswork; §6 records this as deferred rather than forgotten.

**Price basis — GST-exclusive**, chosen by the owner and reasoned in ADR-0008.

### "Price can be changed according to situation" — how that requirement is actually met

Five mechanisms, designed together in ADR-0007, not one:

| Lever | Varies price by | Where |
|---|---|---|
| Price list versions | Season, contract, partner tier | Clone → adjust → publish |
| Volume slabs | Quantity | `PriceListItem.minQty` |
| Discount rules | Product, category, distributor, list, date, threshold | `DiscountRule`, priority-resolved |
| **Manual override** | **The individual deal** | `POST /pricing/quote`, mandatory reason |
| Price floor | Guard-rail on all of the above | `PriceListItem.minPrice` |

The override is the direct answer. It replaces the resolved price, **requires a reason of at least
ten characters**, reports the effective discount against list, and flags the line when it exceeds
the caller's role ceiling or the slab's floor — flagged, never refused. A pricing engine that
refuses would stop a salesperson seeing what a deal even looks like; enforcement belongs to order
approval in Phase 7, which is the thing that can actually block a commitment.

---

## 3. What was seeded, and what is a placeholder

14 products from the portfolio: the Raksha IoT flagship as a **KIT** with a real bill of materials
(2 gateways + 50 tags + a server licence + commissioning, plus an optional AMC), its four
components, plus ATE, test bench, machine vision, DAQ, PCB design, embedded firmware, LabVIEW
integration, training, and AMC.

Also: 19 categories from the nine published service lines, 10 UOMs with GST **UQC** codes, 15 GST
rates, 3 brands, a default price list with 16 price points and three volume slabs on the worker
tag, and one example discount rule.

> ⚠️ **Every price is a placeholder.** They are plausible for the segment, not quoted from Hixaa's
> books. The whole point of the design above is that correcting them is data entry, not a
> migration. The specifications likewise are representative; the ones on Raksha come from the
> published feature list, the electrical values are illustrative.

---

## 4. Verification — by execution, not assertion

Per HANDOFF §4.4, a control is not verified until something is **refused**. All of the following
were run against the booted API and a live database.

### 4.1 Database-level guarantees actually refuse

| Attempt | Result |
|---|---|
| ACTIVE product with **both** HSN and SAC | ❌ `product_hsn_xor_sac` |
| ACTIVE `SERVICE` classified by HSN | ❌ `product_service_uses_sac` |
| Negative GST rate | ❌ `product_gst_rate_sane` |
| DRAFT product with neither code (the deliberate exemption) | ✅ accepted |
| **Second** default price list | ❌ `price_list_single_default_idx` |
| Many **non**-default lists | ✅ accepted — proving the partial index, not a plain unique |
| Second open-ended tax rate for one HSN | ❌ `tax_rate_single_open_ended_idx` |
| BOM row pointing at itself | ❌ `product_bom_no_self_reference` |

17 CHECK constraints and 4 partial unique indexes were confirmed present and enforcing.

### 4.2 Scope enforcement — `distributorProduct` (seam 2)

`west.manager@hixaa.test` is scoped to the WEST zone and can see `DIST-00001` but not `DIST-00002`.
Admin authorized a product for `DIST-00002` first, so there was real data to leak.

| Operation on the out-of-scope distributor | Result |
|---|---|
| `GET /distributors/:id/products` | **404** |
| `POST /distributors/:id/products` | **404** |
| `DELETE /distributors/:id/products/:productId` | **404** |
| `POST /distributors/:id/products/bulk` | **404** |
| `POST /pricing/quote` for that distributor | **404** |
| Same operations **in** scope | 200 / 201 — not merely denying everything |

404 rather than 403 is deliberate: a 403 confirms the record exists and turns the endpoint into an
enumeration oracle.

**Writes needed their own guard.** The scope extension filters reads; it cannot filter an INSERT,
because `distributorId` arrives in the request body and there is no row to match against.
`assertDistributorVisible()` re-reads the distributor through the scoped client, so an out-of-scope
id comes back empty. Without it, every write path above would have succeeded.

### 4.3 Permission enforcement — the independent dimension

`support@hixaa.test` holds `product:read` and nothing else in the catalog:

| Request | Result |
|---|---|
| `GET /products` | 200 |
| `POST /products` · `POST /categories` · `POST /price-lists/:id/publish` · `POST /discount-rules` · `POST /tax-rates` | **403** each |

The database was then queried directly to confirm **nothing was created**.

### 4.4 Pricing correctness

| Case | Result |
|---|---|
| 1 × Raksha kit, Maharashtra (intra-state) | ₹7,42,000 taxable → CGST 66,780 + SGST 66,780 = ₹1,33,560 ✓ |
| Same kit, GSTIN state 29 (inter-state) | IGST ₹1,33,560, CGST/SGST zero — same total, different heads ✓ |
| 2 × kit (₹14.84L ≥ the rule's ₹10L threshold) | 5% applied, unit ₹7,04,900, grand ₹16,63,564 ✓ |
| 1 × kit (₹7.42L, below threshold) | Rule **rejected**, trace: *"line value 742000.00 is below the rule's minimum of 1000000.00"* ✓ |
| Volume slabs at qty 1 / 50 / 200 | ₹4,200 → ₹3,990 → ₹3,750, correct slab reported in the trace ✓ |
| Override to ₹5,60,000 with a reason | Applied, 24.53% effective discount, `requiresApproval: true`, floor breach named ✓ |
| Override **without** a reason | **422**, field `lines[0].override.reason` ✓ |
| Product with no price-list entry | **409 `PRICE_NOT_FOUND`** — never a zero-priced line ✓ |
| BOM explosion, 2 × kit | 4 gateways, 100 tags, 2 licences, 2 commissionings, 2 optional AMCs ✓ |

### 4.5 Frontend

Booted, logged in, and driven in a real browser. Products list renders 14 products with status,
category, HSN/SAC and GST; the Raksha detail page renders classification, the price table with its
floor, the full BOM with the optional AMC marked, and grouped specifications; price lists renders
the default list. Indian currency formatting (`₹7,42,000.00`) correct throughout.

---

## 5. Two real bugs that only execution caught

Both passed lint, typecheck, and build. This is the third time on this project that a green build
has coexisted with broken behaviour, and the reason the standard exists.

**1. The typo-tolerant search never fired.** The fallback used pg_trgm's `%` operator, which
compares **whole strings** against a 0.3 threshold. Measured on real rows,
`similarity('Raksha IoT Gateway', 'raksah')` is **0.18** — the long product name dilutes the match,
so `%` returned nothing and the fallback was dead code that looked correct. `word_similarity`
scores the query against the closest *word* instead and gives **0.57**. Fixed, and re-verified:
`?q=raksah` now returns the Raksha products. The sequential scan this implies is a deliberate
trade — it runs only when exact FTS finds nothing, so the common path stays on the GIN index.

**2. The product detail page double-unwrapped its response.** `apiFetch` already strips the
`{ data }` envelope for a single resource (it keeps the envelope only when `meta` is present, i.e.
for lists). The page did `.then(r => r.data)` on top of that, so `data` was `undefined` and the
page rendered "Product not found" against a **200 OK** response. Types could not catch it because
the generic was written to match the wrong shape.

---

## 6. Deferred, with reasons

| Deferred | Why |
|---|---|
| Bulk product CSV import | E8 established there is nothing to import. An importer for an unseen format is guesswork; the catalog seeds from the portfolio instead |
| `CONFIGURABLE` option-matrix UI | Type and variant model exist; choosing a configuration is a Phase 7 quotation concern |
| Product images | `ProductMedia` links a `Document`; storage is local-disk until S3 (Phase 10). Brochures and datasheets work today |
| Discount **approval enforcement** | The engine flags `requiresApproval`; the workflow that blocks on it is Phase 7 |
| Catalog create/edit **forms** | Consistent with the project-wide gap — all mutations are API-complete and curl-verified, no forms anywhere yet |
| Cost price / margin reporting | No purchase side exists. A margin computed against a cost nobody maintains is worse than none |
| Search relevance **pagination** | Searched lists return one ranked page of ≤200 and set `meta.truncated`. Ranking and keyset cursors are incompatible; the cap is reported rather than silent |

### One thing Phase 8 must not forget

`TaxRate` is authoritative, but when no rate row covers a product's HSN/SAC the engine **falls back
to `Product.gstRate`** and records `taxRateSource: 'PRODUCT_SNAPSHOT'` in the trace. That is right
for a quote — a conversation — and wrong for an invoice. **Phase 8 invoicing must refuse to ISSUE
against a `PRODUCT_SNAPSHOT` source.** The signal is already in the response; only the check is
missing.

---

## 7. Notes for the next phase

- `PricingService.quote()` is the **only** place a price is decided. Phase 7 and 8 must call it,
  not read `PriceListItem.price`. The compiler cannot enforce this; ADR-0007, the module comment,
  and this line are the enforcement.
- `ProductRelationsService.explode()` is what Phase 6 reserves stock against.
- `SCOPE_REGISTRY` now has four live entries: `territory`, `warehouse`, `distributor`,
  `distributorProduct`. The commented-out Phase 7–8 entries still mark where orders and invoices
  plug in.
- `GstCalculator` and `discount-resolver` are **pure modules** — no DB, no DI. Keep them that way;
  it is why the tax invariant can be property-tested over 4,000 generated invoices.
