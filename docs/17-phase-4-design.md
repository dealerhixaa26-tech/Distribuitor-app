# 17 — Phase 4 Design: Catalog & Pricing

> Gate 1 (Design) for Phase 4. Written before any application code, per `05-roadmap.md`.
> Companion ADRs: **0007** (pricing pipeline) and **0008** (GST-exclusive basis and tax).
> Completion record: `18-phase-4-completion.md`.

---

## 1. Why this phase is the critical path

Phase 4 was skipped to build Phase 5 first. Everything downstream is blocked on it: an order needs
a priced line, an invoice needs a taxed line, and an inventory reservation needs something to
reserve. It also closes the two seams Phase 5 deliberately left open:

| Seam | Left open in Phase 5 | Closed here |
|---|---|---|
| 1 | `Distributor.priceListId` — a plain `uuid` column with no FK | FK to `price_list(id)`, added in migration 0006 |
| 2 | "Which products may this distributor buy?" — unanswerable | `DistributorProduct`, the authorized catalog |

## 2. Two decisions taken with the owner before coding

**E8 — existing data to import.** Answer: *"i have the company portfolio add the products and make
it such that its price can be changed according to situation."*

Two consequences, both load-bearing:

1. **The catalog is seeded from the company portfolio**, which is already staged in
   `prisma/seed/portfolio.seed.ts` as `HIXAA_SERVICE_LINES`, `HIXAA_INDUSTRIES`, and `RAKSHA_IOT`.
   That file's own header anticipated this: *"In Phases 3–4 the service lines become `Category`
   rows… this file will populate those tables."* Phase 4 is the promotion it was written for.
   No new import format is invented, and no CSV importer is built for data that does not exist.
2. **Pricing must be situational.** This is not satisfied by a price-list lookup. It is satisfied by
   five mechanisms, designed together in ADR-0007: versioned lists, volume slabs, priority-resolved
   discount rules, a mandatory-reason manual override, and a full trace of how the number was
   reached.

**Price basis.** GST-exclusive, chosen by the owner. Recorded and reasoned in ADR-0008.

## 3. What is reused rather than rebuilt

Phase 4 writes less new infrastructure than its size suggests. Already present and used as-is:

| Existing | Used for |
|---|---|
| `PRODUCT_TYPES`, `PRODUCT_STATUSES`, `PRODUCT_MEDIA_TYPES`, `PRICE_LIST_STATUSES`, `DISCOUNT_SCOPES`, `DISCOUNT_TYPES` in `contracts/enums.ts` | Every catalog enum — all defined in Phase 0, none new |
| `PRODUCT_*`, `CATEGORY_*`, `PRICELIST_*`, `DISCOUNT_*` in `contracts/permissions.ts` | The whole permission surface — already seeded |
| `hsnSchema`, `sacSchema`, `gstRateSchema`, `stateCodeFromGstin`, `HIXAA_STATE_CODE` | Validation and the place-of-supply split |
| `Money` (ADR-0004) | All price and tax arithmetic |
| `territory-path.ts` — `buildPath`, `subtreePattern`, `wouldCreateCycle`, `rewritePath` | The nested category tree, unchanged. A second tree does not need a second implementation |
| `keysetWhere`, `toListResult`, `parseSort` | Every list endpoint |
| `NumberSequenceService` | `SKU` and `PL` code allocation |
| `DocumentsService` + `Document` | Brochures and datasheets — `ProductMedia` points at a `Document`, it does not re-implement uploads |
| `AuditService`, `OutboxService` | Mutation trail and side effects |
| `DataTable`, `PageHeader`, `EmptyState`, `StatusBadge`, `Money` formatting | The frontend |

New infrastructure is limited to the pricing engine and the GST calculator, which are genuinely new
domain logic.

## 4. Schema — migration 0006

Fourteen models. Every `DateTime` carries `@db.Timestamptz(3)` (HANDOFF §4.8); every table with a
`deletedAt` is enrolled in soft delete automatically (§4.2).

### 4.1 Reference and classification

- **`UnitOfMeasure`** — `NOS`, `SET`, `MTR`, `HRS`… carrying the GST-mandated **UQC** code.
  Separate from a free-text string because UQC is validated on GSTR-1 filing.
- **`Brand`** — Hixaa's own plus the OEM brands it integrates (NI, and others).
- **`Category`** — nested, materialised path, reusing `territory-path.ts`. Seeded from
  `HIXAA_SERVICE_LINES`, whose `children` arrays become the second level.

### 4.2 Product and its satellites

- **`Product`** — the four types, `status`, HSN **or** SAC, `gstRate` snapshot (display only —
  ADR-0008 §2), `isSerialized`, `isBatchTracked`, `warrantyMonths`, `leadTimeDays`, `minOrderQty`,
  and a generated `searchVector` with a GIN index.
- **`ProductVariant`** — for `CONFIGURABLE`; a variant may carry its own SKU and price rows.
- **`ProductSpecification`** — real rows, not JSON, so "DAQ modules at 24 V DC" is an indexed query.
  Industrial buyers filter on specifications; this is a functional requirement, not tidiness.
- **`ProductMedia`** — joins `Product` to an existing `Document`.
- **`ProductBom`** — parent/component with quantity and `isOptional`. This is what makes
  "Raksha IoT — 50-Worker Deployment" a sellable line that explodes into gateways, tags, licences,
  and commissioning.
- **`ProductRevision`** — an append-only snapshot of the commercially significant fields on each
  change. A quotation issued against revision 3 must remain explicable after revision 4 lands.

### 4.3 Pricing and tax

- **`PriceList`** — `code`, `status`, `validFrom`/`validTo`, `isDefault`, `priceBasis`, and
  `version` + `clonedFromId` so a new season is a clone-and-publish rather than an edit in place.
- **`PriceListItem`** — `(priceListId, productId, variantId, minQty)`. The `minQty` column *is* the
  volume slab: rows at 1 / 10 / 50 for one product are three slabs.
- **`DiscountRule`** — scope + target, percent or flat, `minQty`, `minAmount`, `priority`, date
  window, `isActive`.
- **`TaxRate`** — date-effective by HSN/SAC, with `cessRate` for completeness.

### 4.4 The channel seam

- **`DistributorProduct`** — the authorized catalog. `(distributorId, productId)` unique, with an
  optional `customPriceListId` for a partner on bespoke terms.

**This is the only Phase 4 model that is scope-sensitive**, and it is registered in
`SCOPE_REGISTRY` as `viaDistributor()`. The rest of the catalog is company-wide reference data and
is deliberately *not* scoped: a product is not owned by a territory. Getting this backwards in
either direction is a bug — over-scoping makes the catalog invisible, under-scoping leaks one
partner's commercial terms to another.

### 4.5 Indexes, and why each exists

| Index | Justification |
|---|---|
| `product(search_vector)` GIN | Full-text search over name, SKU, description, tags |
| `product(category_id, status)` | The catalog browse query |
| `product(status, created_at desc, id desc)` | Keyset pagination, matching `KEYSET_ORDER` |
| `product_specification(name, value)` | Spec filtering — the reason specs are rows |
| `price_list_item(price_list_id, product_id, min_qty desc)` | Slab selection reads this exactly once per line, descending |
| `discount_rule(is_active, scope, target_id)` | Candidate-rule gathering per quote |
| `tax_rate(hsn_sac_code, effective_from desc)` | Date-effective rate lookup |
| `distributor_product(distributor_id, product_id)` unique | The authorization check, and it prevents duplicates |
| `category(path)` | Subtree queries via `LIKE '<path>%'` |

## 5. API surface

Roughly 40 endpoints across six controllers, all following the existing conventions —
`@RequirePermission`, Zod pipes, keyset lists.

```
GET    /categories                    tree or flat
POST   /categories                    · PATCH /categories/:id · DELETE /categories/:id
POST   /categories/:id/move           reparent, cycle-guarded

GET    /products                      q, type, status, categoryId, brandId, keyset
GET    /products/:id                  full detail: specs, media, BOM, variants, prices
POST   /products                      · PATCH /products/:id · DELETE /products/:id
POST   /products/:id/specifications   · DELETE /products/:id/specifications/:specId
POST   /products/:id/media            links an existing Document
POST   /products/:id/bom              · DELETE /products/:id/bom/:componentId
GET    /products/:id/bom/explode      recursive, cycle-guarded, quantity-multiplied
POST   /products/:id/status           DRAFT → ACTIVE → DISCONTINUED → ARCHIVED

GET    /price-lists                   · GET /price-lists/:id · POST · PATCH
POST   /price-lists/:id/clone         new version, DRAFT
POST   /price-lists/:id/publish       DRAFT → ACTIVE, own permission
PUT    /price-lists/:id/items         bulk upsert of slabs

GET    /discount-rules                · POST · PATCH · DELETE
GET    /tax-rates                     · POST  (date-effective; supersede, never edit)

GET    /distributors/:id/products     the authorized catalog — SCOPED
POST   /distributors/:id/products     · DELETE /distributors/:id/products/:productId

POST   /pricing/quote                 ⭐ the one pricing entry point (ADR-0007)
```

## 6. `POST /pricing/quote` — the shape

```jsonc
// request
{
  "distributorId": "…",              // optional; drives price list + place of supply
  "asOf": "2026-08-04",              // optional; defaults to today
  "placeOfSupplyStateCode": "27",    // optional; defaults to the distributor's GSTIN state
  "lines": [
    { "productId": "…", "quantity": "50",
      "override": { "unitPrice": "118000.0000", "reason": "Matched competitor on NTPC tender" } }
  ]
}
```

The response returns, per line: the resolved unit price, the slab that matched, the discount rule
that won and those that lost, the override's effective discount and whether it exceeds the caller's
ceiling, the taxable value, and the CGST/SGST/IGST split — plus document totals with `roundOff`.

## 7. Verification plan

HANDOFF §4.4: *a security control is not verified until something is refused.* Green tests are not
evidence. Before this phase is called done:

1. **Boot the API and exercise every endpoint with `curl`** as `admin@hixaa.com`.
2. **Query the database directly** to confirm what was written — including that the category path is
   well-formed and the FTS vector populated.
3. **Prove refusal, twice over**, using the accounts that exist for it:
   - `west.manager@hixaa.test` must receive **404** reading *and* writing the authorized catalog of
     a distributor outside the WEST subtree.
   - `support@hixaa.test`, which holds `product:read` but not `product:create`, must receive **403**
     on catalog mutations.
4. **Prove the negative pricing paths**: a product with no price list entry must fail `NO_PRICE`,
   not return zero; an override without a reason must be rejected by validation.
5. **Property-based test** that line taxes sum to document tax across generated invoices (ADR-0008).
6. `pnpm verify` green — lint, typecheck, tests, build.

## 8. Explicitly deferred, with reasons

| Deferred | Why |
|---|---|
| Bulk product CSV import | E8 established there is no export to import. The endpoint would be untested against real data and is speculative; the catalog seeds from the portfolio instead |
| `CONFIGURABLE` option-matrix UI | The type and variant model exist; the configurator is a Phase 7 quotation concern, where a configuration is actually chosen |
| Product images | `ProductMedia` links `Document`, and the storage driver is local-disk until S3 lands (Phase 10). Brochures and datasheets work today |
| Discount approval enforcement | The engine flags `requiresApproval`; the workflow that *blocks* on it is Phase 7, which owns order approval |
| Cost price / margin reporting | No purchase side exists until procurement. A margin figure computed against a cost nobody maintains is worse than no figure |
