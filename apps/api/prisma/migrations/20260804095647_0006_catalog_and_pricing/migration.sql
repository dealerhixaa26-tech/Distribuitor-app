-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('GOODS', 'SERVICE', 'KIT', 'CONFIGURABLE');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISCONTINUED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProductMediaType" AS ENUM ('IMAGE', 'BROCHURE', 'DATASHEET', 'MANUAL', 'CERTIFICATE', 'VIDEO', 'CAD');

-- CreateEnum
CREATE TYPE "PriceListStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PriceBasis" AS ENUM ('EXCLUSIVE', 'INCLUSIVE');

-- CreateEnum
CREATE TYPE "DiscountScope" AS ENUM ('GLOBAL', 'PRICE_LIST', 'DISTRIBUTOR', 'CATEGORY', 'PRODUCT');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENT', 'FLAT');

-- CreateTable
CREATE TABLE "unit_of_measure" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "uqc" TEXT NOT NULL,
    "precision" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "unit_of_measure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "website" TEXT,
    "logo_document_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parent_id" UUID,
    "path" TEXT NOT NULL DEFAULT '',
    "depth" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "image_document_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "updated_by_id" UUID,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "ProductType" NOT NULL DEFAULT 'GOODS',
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "category_id" UUID,
    "brand_id" UUID,
    "uom_id" UUID,
    "short_description" TEXT,
    "description" TEXT,
    "hsn_code" TEXT,
    "sac_code" TEXT,
    "gst_rate" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "is_serialized" BOOLEAN NOT NULL DEFAULT false,
    "is_batch_tracked" BOOLEAN NOT NULL DEFAULT false,
    "is_returnable" BOOLEAN NOT NULL DEFAULT true,
    "is_purchasable" BOOLEAN NOT NULL DEFAULT true,
    "is_sellable" BOOLEAN NOT NULL DEFAULT true,
    "warranty_months" INTEGER,
    "lead_time_days" INTEGER,
    "min_order_qty" DECIMAL(18,4) NOT NULL DEFAULT 1,
    "weight_grams" DECIMAL(18,4),
    "tags" TEXT[],
    "search_vector" tsvector,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "updated_by_id" UUID,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variant" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "product_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_specification" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "group_name" TEXT,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "unit" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_specification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_media" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "type" "ProductMediaType" NOT NULL DEFAULT 'IMAGE',
    "title" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_bom" (
    "id" UUID NOT NULL,
    "parent_product_id" UUID NOT NULL,
    "component_product_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "is_optional" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_bom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_revision" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changed_by" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "PriceListStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "price_basis" "PriceBasis" NOT NULL DEFAULT 'EXCLUSIVE',
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "cloned_from_id" UUID,
    "description" TEXT,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "updated_by_id" UUID,

    CONSTRAINT "price_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list_item" (
    "id" UUID NOT NULL,
    "price_list_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "min_qty" DECIMAL(18,4) NOT NULL DEFAULT 1,
    "price" DECIMAL(18,4) NOT NULL,
    "min_price" DECIMAL(18,4),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "price_list_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_rule" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "DiscountScope" NOT NULL DEFAULT 'GLOBAL',
    "target_id" UUID,
    "type" "DiscountType" NOT NULL DEFAULT 'PERCENT',
    "value" DECIMAL(18,4) NOT NULL,
    "min_qty" DECIMAL(18,4),
    "min_amount" DECIMAL(18,4),
    "max_discount_amount" DECIMAL(18,4),
    "priority" INTEGER NOT NULL DEFAULT 100,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "updated_by_id" UUID,

    CONSTRAINT "discount_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rate" (
    "id" UUID NOT NULL,
    "hsn_sac_code" TEXT NOT NULL,
    "gst_rate" DECIMAL(5,2) NOT NULL,
    "cess_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "description" TEXT,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by_id" UUID,

    CONSTRAINT "tax_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distributor_product" (
    "id" UUID NOT NULL,
    "distributor_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "custom_price_list_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "authorized_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "max_order_qty" DECIMAL(18,4),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,

    CONSTRAINT "distributor_product_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "unit_of_measure_code_key" ON "unit_of_measure"("code");

-- CreateIndex
CREATE INDEX "unit_of_measure_is_active_idx" ON "unit_of_measure"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "brand_code_key" ON "brand"("code");

-- CreateIndex
CREATE UNIQUE INDEX "brand_slug_key" ON "brand"("slug");

-- CreateIndex
CREATE INDEX "brand_is_active_idx" ON "brand"("is_active");

-- CreateIndex
CREATE INDEX "brand_deleted_at_idx" ON "brand"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "category_code_key" ON "category"("code");

-- CreateIndex
CREATE UNIQUE INDEX "category_slug_key" ON "category"("slug");

-- CreateIndex
CREATE INDEX "category_parent_id_idx" ON "category"("parent_id");

-- CreateIndex
CREATE INDEX "category_path_idx" ON "category"("path");

-- CreateIndex
CREATE INDEX "category_is_active_sort_order_idx" ON "category"("is_active", "sort_order");

-- CreateIndex
CREATE INDEX "category_deleted_at_idx" ON "category"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "product_sku_key" ON "product"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "product_slug_key" ON "product"("slug");

-- CreateIndex
CREATE INDEX "product_category_id_status_idx" ON "product"("category_id", "status");

-- CreateIndex
CREATE INDEX "product_brand_id_idx" ON "product"("brand_id");

-- CreateIndex
CREATE INDEX "product_type_status_idx" ON "product"("type", "status");

-- CreateIndex
CREATE INDEX "product_status_created_at_id_idx" ON "product"("status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "product_hsn_code_idx" ON "product"("hsn_code");

-- CreateIndex
CREATE INDEX "product_sac_code_idx" ON "product"("sac_code");

-- CreateIndex
CREATE INDEX "product_deleted_at_idx" ON "product"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "product_variant_sku_key" ON "product_variant"("sku");

-- CreateIndex
CREATE INDEX "product_variant_product_id_is_active_idx" ON "product_variant"("product_id", "is_active");

-- CreateIndex
CREATE INDEX "product_variant_deleted_at_idx" ON "product_variant"("deleted_at");

-- CreateIndex
CREATE INDEX "product_specification_product_id_sort_order_idx" ON "product_specification"("product_id", "sort_order");

-- CreateIndex
CREATE INDEX "product_specification_name_value_idx" ON "product_specification"("name", "value");

-- CreateIndex
CREATE INDEX "product_media_product_id_type_sort_order_idx" ON "product_media"("product_id", "type", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "product_media_product_id_document_id_type_key" ON "product_media"("product_id", "document_id", "type");

-- CreateIndex
CREATE INDEX "product_bom_component_product_id_idx" ON "product_bom"("component_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_bom_parent_product_id_component_product_id_key" ON "product_bom"("parent_product_id", "component_product_id");

-- CreateIndex
CREATE INDEX "product_revision_product_id_created_at_idx" ON "product_revision"("product_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "product_revision_product_id_revision_key" ON "product_revision"("product_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_code_key" ON "price_list"("code");

-- CreateIndex
CREATE INDEX "price_list_status_valid_from_idx" ON "price_list"("status", "valid_from");

-- CreateIndex
CREATE INDEX "price_list_deleted_at_idx" ON "price_list"("deleted_at");

-- CreateIndex
CREATE INDEX "price_list_item_price_list_id_product_id_min_qty_idx" ON "price_list_item"("price_list_id", "product_id", "min_qty" DESC);

-- CreateIndex
CREATE INDEX "price_list_item_product_id_idx" ON "price_list_item"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "discount_rule_code_key" ON "discount_rule"("code");

-- CreateIndex
CREATE INDEX "discount_rule_is_active_scope_target_id_idx" ON "discount_rule"("is_active", "scope", "target_id");

-- CreateIndex
CREATE INDEX "discount_rule_valid_from_valid_to_idx" ON "discount_rule"("valid_from", "valid_to");

-- CreateIndex
CREATE INDEX "discount_rule_deleted_at_idx" ON "discount_rule"("deleted_at");

-- CreateIndex
CREATE INDEX "tax_rate_hsn_sac_code_effective_from_idx" ON "tax_rate"("hsn_sac_code", "effective_from" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tax_rate_hsn_sac_code_effective_from_key" ON "tax_rate"("hsn_sac_code", "effective_from");

-- CreateIndex
CREATE INDEX "distributor_product_distributor_id_is_active_idx" ON "distributor_product"("distributor_id", "is_active");

-- CreateIndex
CREATE INDEX "distributor_product_product_id_idx" ON "distributor_product"("product_id");

-- CreateIndex
CREATE INDEX "distributor_product_deleted_at_idx" ON "distributor_product"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "distributor_product_distributor_id_product_id_key" ON "distributor_product"("distributor_id", "product_id");

-- CreateIndex
CREATE INDEX "distributor_price_list_id_idx" ON "distributor"("price_list_id");

-- AddForeignKey
ALTER TABLE "distributor" ADD CONSTRAINT "distributor_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_list"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "unit_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_specification" ADD CONSTRAINT "product_specification_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_bom" ADD CONSTRAINT "product_bom_parent_product_id_fkey" FOREIGN KEY ("parent_product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_bom" ADD CONSTRAINT "product_bom_component_product_id_fkey" FOREIGN KEY ("component_product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_revision" ADD CONSTRAINT "product_revision_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list" ADD CONSTRAINT "price_list_cloned_from_id_fkey" FOREIGN KEY ("cloned_from_id") REFERENCES "price_list"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_item" ADD CONSTRAINT "price_list_item_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_list"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_item" ADD CONSTRAINT "price_list_item_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_item" ADD CONSTRAINT "price_list_item_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributor_product" ADD CONSTRAINT "distributor_product_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributor_product" ADD CONSTRAINT "distributor_product_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributor_product" ADD CONSTRAINT "distributor_product_custom_price_list_id_fkey" FOREIGN KEY ("custom_price_list_id") REFERENCES "price_list"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- 0006b — Catalog guarantees Prisma's schema language cannot express.
--
-- Same principle as 0002: these are correctness controls, not optimisations.
-- Each holds even when application logic is bypassed, buggy, or written by
-- someone who has not read docs/17-phase-4-design.md.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Full-text search over products ──────────────────────────────────────────
-- A GENERATED column, so Postgres maintains it on every write and no service
-- can forget to. Prisma cannot express generated columns, which is exactly why
-- the model declares it `Unsupported` — the ORM never tries to write it.
--
-- Weights: name (A) outranks SKU (B), which outranks tags (C) and description
-- (D). Searching "raksha" should surface the product before it surfaces every
-- item whose description happens to mention it.
-- `array_to_string` is declared STABLE, not IMMUTABLE — in general an array's
-- element output function need not be immutable, so Postgres refuses it in a
-- generated expression. For `text[]` specifically the output IS immutable
-- (text_out is), so an explicitly IMMUTABLE wrapper is sound rather than a lie
-- told to the planner. Restricting the signature to text[] is what makes the
-- assertion safe; do not widen it to anyarray.
CREATE OR REPLACE FUNCTION immutable_text_array_join(text[], text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$ SELECT array_to_string($1, $2) $$;

ALTER TABLE "product" DROP COLUMN "search_vector";
ALTER TABLE "product" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("name", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("sku", '')), 'B') ||
    setweight(to_tsvector('english', coalesce(immutable_text_array_join("tags", ' '), '')), 'C') ||
    setweight(to_tsvector('english', coalesce("short_description", '')), 'D') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'D')
  ) STORED;

CREATE INDEX "product_search_vector_idx" ON "product" USING GIN ("search_vector");

-- Typo tolerance ("raksah" → "Raksha"), using the pg_trgm extension that
-- migration 0002 installed for precisely this phase.
CREATE INDEX "product_name_trgm_idx" ON "product" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "product_sku_trgm_idx" ON "product" USING GIN ("sku" gin_trgm_ops);


-- ── A product carries an HSN or a SAC, never both, never neither once ACTIVE ─
-- HSN classifies goods, SAC classifies services. A service invoiced under an
-- HSN code is a GST filing defect that surfaces at return time, long after the
-- invoice reached the customer. DRAFT is exempt so a product can be saved
-- before its tax classification is known.
ALTER TABLE "product" ADD CONSTRAINT "product_hsn_xor_sac"
  CHECK (
    "status" = 'DRAFT'
    OR (("hsn_code" IS NOT NULL)::int + ("sac_code" IS NOT NULL)::int) = 1
  );

-- A SERVICE is classified by SAC; goods and kits by HSN.
ALTER TABLE "product" ADD CONSTRAINT "product_service_uses_sac"
  CHECK ("status" = 'DRAFT' OR "type" <> 'SERVICE' OR "sac_code" IS NOT NULL);

ALTER TABLE "product" ADD CONSTRAINT "product_min_order_qty_positive"
  CHECK ("min_order_qty" > 0);

ALTER TABLE "product" ADD CONSTRAINT "product_gst_rate_sane"
  CHECK ("gst_rate" >= 0 AND "gst_rate" <= 100);


-- ── A bill of materials cannot contain itself ───────────────────────────────
-- Guards the direct case only. Deeper cycles (A→B→A) are caught by the
-- explosion walker in BomService, which is the only place with the whole graph
-- in view — but a self-reference is cheap to forbid outright and is the typo
-- an operator actually makes.
ALTER TABLE "product_bom" ADD CONSTRAINT "product_bom_no_self_reference"
  CHECK ("parent_product_id" <> "component_product_id");

ALTER TABLE "product_bom" ADD CONSTRAINT "product_bom_quantity_positive"
  CHECK ("quantity" > 0);


-- ── Exactly one default price list ──────────────────────────────────────────
-- A plain UNIQUE on a boolean permits only one `false` row, which is the
-- opposite of what is wanted. A partial unique index constrains only the `true`
-- rows. Without this, "the default list" is whichever row the planner returns
-- first — a silent, irreproducible pricing bug.
CREATE UNIQUE INDEX "price_list_single_default_idx"
  ON "price_list" ("is_default")
  WHERE "is_default" = true AND "deleted_at" IS NULL;

ALTER TABLE "price_list" ADD CONSTRAINT "price_list_valid_range"
  CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from");


-- ── One price per (list, product, variant, slab) ────────────────────────────
-- Postgres treats NULLs as distinct in a UNIQUE constraint, so a plain unique
-- over a nullable `variant_id` would happily accept two product-level slabs at
-- the same quantity — and the pricing engine would then return whichever row
-- came back first. Two partial indexes cover both cases properly.
CREATE UNIQUE INDEX "price_list_item_product_slab_idx"
  ON "price_list_item" ("price_list_id", "product_id", "min_qty")
  WHERE "variant_id" IS NULL;

CREATE UNIQUE INDEX "price_list_item_variant_slab_idx"
  ON "price_list_item" ("price_list_id", "product_id", "variant_id", "min_qty")
  WHERE "variant_id" IS NOT NULL;

-- A price list is GST-exclusive and prices are what a customer pays: negative
-- is never meaningful, and zero is a giveaway that must be deliberate rather
-- than the result of an empty form field.
ALTER TABLE "price_list_item" ADD CONSTRAINT "price_list_item_price_non_negative"
  CHECK ("price" >= 0);

ALTER TABLE "price_list_item" ADD CONSTRAINT "price_list_item_min_qty_positive"
  CHECK ("min_qty" > 0);

ALTER TABLE "price_list_item" ADD CONSTRAINT "price_list_item_floor_below_price"
  CHECK ("min_price" IS NULL OR "min_price" <= "price");


-- ── Discount rules ──────────────────────────────────────────────────────────
-- A PERCENT rule above 100 is not a discount, it is a payment to the customer.
ALTER TABLE "discount_rule" ADD CONSTRAINT "discount_rule_value_sane"
  CHECK (
    "value" >= 0
    AND ("type" <> 'PERCENT' OR "value" <= 100)
  );

-- GLOBAL is the only scope without a target; every other scope names something.
ALTER TABLE "discount_rule" ADD CONSTRAINT "discount_rule_target_matches_scope"
  CHECK (
    ("scope" = 'GLOBAL' AND "target_id" IS NULL)
    OR ("scope" <> 'GLOBAL' AND "target_id" IS NOT NULL)
  );

ALTER TABLE "discount_rule" ADD CONSTRAINT "discount_rule_valid_range"
  CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from");

-- Candidate gathering reads only live rules, so the index covers only those.
CREATE INDEX "discount_rule_active_idx"
  ON "discount_rule" ("scope", "target_id", "priority")
  WHERE "is_active" = true AND "deleted_at" IS NULL;


-- ── Tax rates ───────────────────────────────────────────────────────────────
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_sane"
  CHECK ("gst_rate" >= 0 AND "gst_rate" <= 100 AND "cess_rate" >= 0 AND "cess_rate" <= 100);

ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_effective_range"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- Two open-ended rates for one code would make the resolved rate depend on row
-- order — the same class of bug as two default price lists, but on a legal
-- document. Superseding a rate must close the old row's `effective_to`.
CREATE UNIQUE INDEX "tax_rate_single_open_ended_idx"
  ON "tax_rate" ("hsn_sac_code")
  WHERE "effective_to" IS NULL;


-- ── Category tree ───────────────────────────────────────────────────────────
ALTER TABLE "category" ADD CONSTRAINT "category_not_own_parent"
  CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

-- Subtree reads are `path LIKE '<ancestor path>%'`; text_pattern_ops is what
-- makes a prefix LIKE use the index instead of scanning the table.
CREATE INDEX "category_path_prefix_idx"
  ON "category" ("path" text_pattern_ops);


-- ── Authorized catalog ──────────────────────────────────────────────────────
ALTER TABLE "distributor_product" ADD CONSTRAINT "distributor_product_max_qty_positive"
  CHECK ("max_order_qty" IS NULL OR "max_order_qty" > 0);
