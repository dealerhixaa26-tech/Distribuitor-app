-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('OPENING', 'RECEIPT', 'ISSUE', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT', 'SALES_RETURN', 'SCRAP');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SerialStatus" AS ENUM ('IN_STOCK', 'RESERVED', 'SOLD', 'RMA', 'SCRAPPED');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('DRAFT', 'COUNTING', 'POSTED', 'CANCELLED');

-- ── product.search_vector: GENERATED column → trigger-maintained ───────────
--
-- Migration 0006 made this a GENERATED column, which is the better Postgres
-- feature but which Prisma cannot express. The consequence surfaced here: every
-- subsequent `migrate dev` diffs the real column against Prisma's model of it
-- and proposes stripping the generation expression. Deleting that line by hand
-- each time is a trap nobody will remember in six months.
--
-- A trigger-maintained column is IDENTICAL in behaviour and is a plain nullable
-- tsvector as far as Prisma is concerned, so the drift disappears permanently.
-- This is also the classic Postgres FTS pattern and predates generated columns.
--
-- DROP EXPRESSION keeps the existing values, so no backfill is needed.
ALTER TABLE "product" ALTER COLUMN "search_vector" DROP EXPRESSION;

CREATE OR REPLACE FUNCTION product_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW."search_vector" :=
    setweight(to_tsvector('english', coalesce(NEW."name", '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW."sku", '')), 'B') ||
    setweight(to_tsvector('english', coalesce(immutable_text_array_join(NEW."tags", ' '), '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW."short_description", '')), 'D') ||
    setweight(to_tsvector('english', coalesce(NEW."description", '')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER product_search_vector_trigger
  BEFORE INSERT OR UPDATE OF "name", "sku", "tags", "short_description", "description"
  ON "product"
  FOR EACH ROW EXECUTE FUNCTION product_search_vector_update();

-- CreateTable
CREATE TABLE "batch" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_number" TEXT NOT NULL,
    "manufactured_on" DATE,
    "expires_on" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_ledger_entry" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "batch_id" UUID,
    "movement_type" "StockMovementType" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_cost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "ref_type" TEXT,
    "ref_id" UUID,
    "reason" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "stock_ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balance" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "batch_id" UUID,
    "quantity_on_hand" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "quantity_reserved" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "quantity_available" DECIMAL(18,4),
    "average_cost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "last_movement_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reservation" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "order_id" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(3),
    "released_at" TIMESTAMPTZ(3),
    "consumed_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by_id" UUID,

    CONSTRAINT "stock_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serial_number" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "serial" TEXT NOT NULL,
    "status" "SerialStatus" NOT NULL DEFAULT 'SOLD',
    "warehouse_id" UUID,
    "batch_id" UUID,
    "current_distributor_id" UUID,
    "current_customer_id" UUID,
    "warranty_start" DATE,
    "warranty_end" DATE,
    "dispatched_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by_id" UUID,

    CONSTRAINT "serial_number_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'DRAFT',
    "source_warehouse_id" UUID NOT NULL,
    "destination_warehouse_id" UUID NOT NULL,
    "transit_warehouse_id" UUID,
    "dispatched_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,

    CONSTRAINT "stock_transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_line" (
    "id" UUID NOT NULL,
    "transfer_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "quantity_received" DECIMAL(18,4),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_transfer_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_setting" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "reorder_level" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reorder_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "max_level" DECIMAL(18,4),
    "alert_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'DRAFT',
    "counted_on" DATE NOT NULL,
    "posted_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "posted_by_id" UUID,

    CONSTRAINT "stock_count_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count_line" (
    "id" UUID NOT NULL,
    "stock_count_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "system_quantity" DECIMAL(18,4) NOT NULL,
    "counted_quantity" DECIMAL(18,4),
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_count_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "batch_expires_on_idx" ON "batch"("expires_on");

-- CreateIndex
CREATE UNIQUE INDEX "batch_product_id_lot_number_key" ON "batch"("product_id", "lot_number");

-- CreateIndex
CREATE INDEX "stock_ledger_entry_warehouse_id_product_id_occurred_at_idx" ON "stock_ledger_entry"("warehouse_id", "product_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "stock_ledger_entry_product_id_occurred_at_idx" ON "stock_ledger_entry"("product_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "stock_ledger_entry_ref_type_ref_id_idx" ON "stock_ledger_entry"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "stock_ledger_entry_occurred_at_id_idx" ON "stock_ledger_entry"("occurred_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "stock_balance_warehouse_id_product_id_idx" ON "stock_balance"("warehouse_id", "product_id");

-- CreateIndex
CREATE INDEX "stock_balance_product_id_idx" ON "stock_balance"("product_id");

-- CreateIndex
CREATE INDEX "stock_reservation_warehouse_id_product_id_status_idx" ON "stock_reservation"("warehouse_id", "product_id", "status");

-- CreateIndex
CREATE INDEX "stock_reservation_order_id_idx" ON "stock_reservation"("order_id");

-- CreateIndex
CREATE INDEX "stock_reservation_status_expires_at_idx" ON "stock_reservation"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "serial_number_serial_key" ON "serial_number"("serial");

-- CreateIndex
CREATE INDEX "serial_number_product_id_status_idx" ON "serial_number"("product_id", "status");

-- CreateIndex
CREATE INDEX "serial_number_current_distributor_id_idx" ON "serial_number"("current_distributor_id");

-- CreateIndex
CREATE INDEX "serial_number_warranty_end_idx" ON "serial_number"("warranty_end");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_code_key" ON "stock_transfer"("code");

-- CreateIndex
CREATE INDEX "stock_transfer_status_created_at_idx" ON "stock_transfer"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stock_transfer_source_warehouse_id_idx" ON "stock_transfer"("source_warehouse_id");

-- CreateIndex
CREATE INDEX "stock_transfer_deleted_at_idx" ON "stock_transfer"("deleted_at");

-- CreateIndex
CREATE INDEX "stock_transfer_line_product_id_idx" ON "stock_transfer_line"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_line_transfer_id_product_id_variant_id_key" ON "stock_transfer_line"("transfer_id", "product_id", "variant_id");

-- CreateIndex
CREATE INDEX "inventory_setting_warehouse_id_alert_enabled_idx" ON "inventory_setting"("warehouse_id", "alert_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_setting_product_id_warehouse_id_key" ON "inventory_setting"("product_id", "warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_count_code_key" ON "stock_count"("code");

-- CreateIndex
CREATE INDEX "stock_count_warehouse_id_status_idx" ON "stock_count"("warehouse_id", "status");

-- CreateIndex
CREATE INDEX "stock_count_deleted_at_idx" ON "stock_count"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "stock_count_line_stock_count_id_product_id_variant_id_key" ON "stock_count_line"("stock_count_id", "product_id", "variant_id");

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch" ADD CONSTRAINT "batch_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entry" ADD CONSTRAINT "stock_ledger_entry_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entry" ADD CONSTRAINT "stock_ledger_entry_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entry" ADD CONSTRAINT "stock_ledger_entry_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entry" ADD CONSTRAINT "stock_ledger_entry_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_number" ADD CONSTRAINT "serial_number_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_number" ADD CONSTRAINT "serial_number_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_number" ADD CONSTRAINT "serial_number_current_distributor_id_fkey" FOREIGN KEY ("current_distributor_id") REFERENCES "distributor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_source_warehouse_id_fkey" FOREIGN KEY ("source_warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_destination_warehouse_id_fkey" FOREIGN KEY ("destination_warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_line" ADD CONSTRAINT "stock_transfer_line_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "stock_transfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_line" ADD CONSTRAINT "stock_transfer_line_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_line" ADD CONSTRAINT "stock_transfer_line_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_setting" ADD CONSTRAINT "inventory_setting_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_setting" ADD CONSTRAINT "inventory_setting_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count" ADD CONSTRAINT "stock_count_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_stock_count_id_fkey" FOREIGN KEY ("stock_count_id") REFERENCES "stock_count"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- 0007b — Inventory guarantees Prisma's schema language cannot express.
--
-- ADR-0002 chose a ledger over a counter so that concurrent dispatch is
-- STRUCTURALLY correct rather than carefully avoided. These constraints are the
-- structure. Each holds even if application logic is bypassed entirely.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── The ledger is append-only, enforced by the database ─────────────────────
-- Same reasoning as the audit_log trigger in migration 0002: a convention that
-- lives only in code is one that a future migration, an ORM escape hatch, or a
-- psql session can quietly break. An edited stock ledger is an unauditable one,
-- and the whole point of the ledger is that it can be trusted to explain a
-- balance. Corrections are compensating ADJUSTMENT rows, never edits.
CREATE OR REPLACE FUNCTION stock_ledger_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'stock_ledger_entry is append-only: % is not permitted. Post a compensating ADJUSTMENT instead.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_ledger_no_update
  BEFORE UPDATE ON "stock_ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_is_append_only();

CREATE TRIGGER stock_ledger_no_delete
  BEFORE DELETE ON "stock_ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_is_append_only();

-- A zero-quantity movement is a non-event recorded as if it were one. It
-- pollutes the audit trail and makes "why is stock 47?" harder to answer.
ALTER TABLE "stock_ledger_entry" ADD CONSTRAINT "stock_ledger_quantity_non_zero"
  CHECK ("quantity" <> 0);

ALTER TABLE "stock_ledger_entry" ADD CONSTRAINT "stock_ledger_cost_non_negative"
  CHECK ("unit_cost" >= 0);

-- The SIGN of the quantity must agree with the movement type. Without this a
-- RECEIPT could be posted with a negative quantity and would silently REDUCE
-- stock while reading as an inbound movement in every report.
ALTER TABLE "stock_ledger_entry" ADD CONSTRAINT "stock_ledger_sign_matches_type"
  CHECK (
    ("movement_type" IN ('OPENING', 'RECEIPT', 'TRANSFER_IN', 'SALES_RETURN') AND "quantity" > 0)
    OR ("movement_type" IN ('ISSUE', 'TRANSFER_OUT', 'SCRAP') AND "quantity" < 0)
    -- ADJUSTMENT is the only type allowed either sign: that is what it is for.
    OR "movement_type" = 'ADJUSTMENT'
  );

-- An unexplained stock change is indistinguishable from theft.
ALTER TABLE "stock_ledger_entry" ADD CONSTRAINT "stock_ledger_adjustment_needs_reason"
  CHECK ("movement_type" NOT IN ('ADJUSTMENT', 'SCRAP') OR "reason" IS NOT NULL);


-- ── The balance: never negative, never over-reserved ────────────────────────
-- The last line of defence. Application logic refuses first and returns a clean
-- 409; this means that even a bug, a bad migration, or a direct SQL session
-- cannot leave the business looking at negative stock.
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_on_hand_non_negative"
  CHECK ("quantity_on_hand" >= 0);

ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_reserved_non_negative"
  CHECK ("quantity_reserved" >= 0);

-- You cannot commit more stock than you physically hold.
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_reserved_within_on_hand"
  CHECK ("quantity_reserved" <= "quantity_on_hand");

ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_average_cost_non_negative"
  CHECK ("average_cost" >= 0);

-- `available` is DERIVED, never hand-maintained. A derived value that
-- application code can set is one that will eventually be set incorrectly, and
-- a wrong "available" figure oversells stock.
--
-- Maintained by a TRIGGER rather than a GENERATED column, for the same reason
-- product.search_vector is (see the head of this migration): Prisma cannot
-- express a generated column, so every future `migrate dev` would diff the real
-- column against Prisma's model and propose stripping it. A BEFORE trigger is
-- behaviourally equivalent — any value a caller supplies is overwritten — and
-- leaves the column looking ordinary to the ORM.
CREATE OR REPLACE FUNCTION stock_balance_available_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW."quantity_available" := NEW."quantity_on_hand" - NEW."quantity_reserved";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_balance_available_trigger
  BEFORE INSERT OR UPDATE ON "stock_balance"
  FOR EACH ROW EXECUTE FUNCTION stock_balance_available_update();

-- Named exactly as Prisma derives it from the @@index declaration in
-- schema.prisma, so the two agree and no drift is reported.
CREATE INDEX "stock_balance_product_id_quantity_available_idx"
  ON "stock_balance" ("product_id", "quantity_available");

-- ── One balance row per stocked thing ───────────────────────────────────────
-- `variant_id` and `batch_id` are nullable and Postgres treats NULLs as
-- DISTINCT in a unique constraint, so a plain unique would happily accept two
-- balance rows for the same (warehouse, product). Two balance rows for one
-- product is silent, permanent corruption: each movement would lock and update
-- whichever row it found first, and the totals would drift apart forever.
-- Four partial indexes cover every nullability combination.
CREATE UNIQUE INDEX "stock_balance_wh_product_idx"
  ON "stock_balance" ("warehouse_id", "product_id")
  WHERE "variant_id" IS NULL AND "batch_id" IS NULL;

CREATE UNIQUE INDEX "stock_balance_wh_product_variant_idx"
  ON "stock_balance" ("warehouse_id", "product_id", "variant_id")
  WHERE "variant_id" IS NOT NULL AND "batch_id" IS NULL;

CREATE UNIQUE INDEX "stock_balance_wh_product_batch_idx"
  ON "stock_balance" ("warehouse_id", "product_id", "batch_id")
  WHERE "variant_id" IS NULL AND "batch_id" IS NOT NULL;

CREATE UNIQUE INDEX "stock_balance_wh_product_variant_batch_idx"
  ON "stock_balance" ("warehouse_id", "product_id", "variant_id", "batch_id")
  WHERE "variant_id" IS NOT NULL AND "batch_id" IS NOT NULL;


-- ── Reservations ────────────────────────────────────────────────────────────
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_quantity_positive"
  CHECK ("quantity" > 0);

-- One ACTIVE reservation per (order, product, warehouse). A second one would
-- double-count against the balance's quantity_reserved and hold stock that
-- nothing is actually waiting for.
CREATE UNIQUE INDEX "stock_reservation_one_active_idx"
  ON "stock_reservation" ("order_id", "product_id", "warehouse_id")
  WHERE "status" = 'ACTIVE' AND "order_id" IS NOT NULL;

-- The expiry sweep reads only live reservations, so the index covers only those.
CREATE INDEX "stock_reservation_expiring_idx"
  ON "stock_reservation" ("expires_at")
  WHERE "status" = 'ACTIVE';


-- ── Warehouses ──────────────────────────────────────────────────────────────
-- Exactly one default, for the same reason as the default price list: without
-- this, "the default warehouse" is whichever row the planner returns first.
CREATE UNIQUE INDEX "warehouse_single_default_idx"
  ON "warehouse" ("is_default")
  WHERE "is_default" = true AND "deleted_at" IS NULL;

-- A DISTRIBUTOR warehouse belongs to a distributor; a COMPANY one does not.
-- Mixing them up would let a partner's stock be counted as Hixaa's own.
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_distributor_matches_type"
  CHECK (
    ("type" = 'DISTRIBUTOR' AND "distributor_id" IS NOT NULL)
    OR ("type" <> 'DISTRIBUTOR' AND "distributor_id" IS NULL)
  );


-- ── Transfers ───────────────────────────────────────────────────────────────
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_distinct_endpoints"
  CHECK ("source_warehouse_id" <> "destination_warehouse_id");

ALTER TABLE "stock_transfer_line" ADD CONSTRAINT "stock_transfer_line_quantity_positive"
  CHECK ("quantity" > 0);

-- Receiving MORE than was dispatched is not a short receipt, it is an error —
-- and it would create stock out of nothing.
ALTER TABLE "stock_transfer_line" ADD CONSTRAINT "stock_transfer_line_receipt_within_dispatch"
  CHECK ("quantity_received" IS NULL OR ("quantity_received" >= 0 AND "quantity_received" <= "quantity"));


-- ── Reorder policy and counts ───────────────────────────────────────────────
ALTER TABLE "inventory_setting" ADD CONSTRAINT "inventory_setting_levels_sane"
  CHECK (
    "reorder_level" >= 0
    AND "reorder_quantity" >= 0
    AND ("max_level" IS NULL OR "max_level" >= "reorder_level")
  );

ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_counted_non_negative"
  CHECK ("counted_quantity" IS NULL OR "counted_quantity" >= 0);
