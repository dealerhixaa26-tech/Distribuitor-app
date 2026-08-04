-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('INDUSTRIAL', 'GOVERNMENT', 'OEM', 'INSTITUTIONAL', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('PRIMARY', 'SECONDARY');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'PARTIALLY_DISPATCHED', 'DISPATCHED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONVERTED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'PACKED', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'RETURNED');

-- CreateEnum
CREATE TYPE "ApprovalKind" AS ENUM ('DISCOUNT', 'ORDER_VALUE', 'CREDIT_LIMIT');

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CustomerType" NOT NULL DEFAULT 'INDUSTRIAL',
    "distributor_id" UUID,
    "territory_id" UUID,
    "industry_id" UUID,
    "gstin" TEXT,
    "pan" TEXT,
    "billing_address_id" UUID,
    "shipping_address_id" UUID,
    "site_name" TEXT,
    "website" TEXT,
    "notes" TEXT,
    "tags" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "updated_by_id" UUID,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contact" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "designation" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "customer_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
    "group_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "distributor_id" UUID,
    "customer_id" UUID,
    "place_of_supply_state_code" TEXT,
    "price_list_id" UUID,
    "quotation_date" DATE NOT NULL,
    "valid_until" DATE,
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_discount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxable_value" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_cgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_sgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_igst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_tax" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "round_off" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "terms_and_conditions" TEXT,
    "notes" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "accepted_at" TIMESTAMPTZ(3),
    "rejected_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,

    CONSTRAINT "quotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_line" (
    "id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "sku" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "product_revision" INTEGER NOT NULL DEFAULT 1,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom_code" TEXT,
    "unit_list_price" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "discount_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "discount_percent" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "discount_rule_id" UUID,
    "override_reason" TEXT,
    "taxable_value" DECIMAL(18,4) NOT NULL,
    "hsn_sac_code" TEXT,
    "gst_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "igst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "cess" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_tax" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,4) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotation_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "type" "OrderType" NOT NULL DEFAULT 'PRIMARY',
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "distributor_id" UUID,
    "customer_id" UUID,
    "quotation_id" UUID,
    "warehouse_id" UUID,
    "place_of_supply_state_code" TEXT,
    "price_list_id" UUID,
    "order_date" DATE NOT NULL,
    "expected_date" DATE,
    "customer_po_number" TEXT,
    "customer_po_date" DATE,
    "payment_terms_code" TEXT,
    "billing_address_id" UUID,
    "shipping_address_id" UUID,
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_discount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxable_value" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_cgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_sgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_igst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_tax" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "round_off" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "credit_overridden" BOOLEAN NOT NULL DEFAULT false,
    "credit_override_reason" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "approved_at" TIMESTAMPTZ(3),
    "approved_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "status_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "sku" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "product_revision" INTEGER NOT NULL DEFAULT 1,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom_code" TEXT,
    "quantity_reserved" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "quantity_backordered" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "quantity_dispatched" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "expected_available_date" DATE,
    "unit_list_price" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "discount_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "discount_percent" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "discount_rule_id" UUID,
    "override_reason" TEXT,
    "taxable_value" DECIMAL(18,4) NOT NULL,
    "hsn_sac_code" TEXT,
    "gst_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "igst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "cess" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_tax" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,4) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_approval" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" "ApprovalKind" NOT NULL,
    "requested_value" DECIMAL(18,4) NOT NULL,
    "approver_ceiling" DECIMAL(18,4),
    "approved_by_id" UUID NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "warehouse_id" UUID NOT NULL,
    "carrier_name" TEXT,
    "lr_number" TEXT,
    "vehicle_number" TEXT,
    "driver_name" TEXT,
    "driver_phone" TEXT,
    "freight_amount" DECIMAL(18,4),
    "packed_at" TIMESTAMPTZ(3),
    "dispatched_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "pod_document_id" UUID,
    "pod_received_by" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,

    CONSTRAINT "shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_line" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "serials" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shipment_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_timeline" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_timeline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_code_key" ON "customer"("code");

-- CreateIndex
CREATE INDEX "customer_territory_id_is_active_idx" ON "customer"("territory_id", "is_active");

-- CreateIndex
CREATE INDEX "customer_distributor_id_idx" ON "customer"("distributor_id");

-- CreateIndex
CREATE INDEX "customer_industry_id_idx" ON "customer"("industry_id");

-- CreateIndex
CREATE INDEX "customer_created_at_id_idx" ON "customer"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "customer_deleted_at_idx" ON "customer"("deleted_at");

-- CreateIndex
CREATE INDEX "customer_contact_customer_id_idx" ON "customer_contact"("customer_id");

-- CreateIndex
CREATE INDEX "customer_contact_deleted_at_idx" ON "customer_contact"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_number_key" ON "quotation"("number");

-- CreateIndex
CREATE INDEX "quotation_status_quotation_date_idx" ON "quotation"("status", "quotation_date" DESC);

-- CreateIndex
CREATE INDEX "quotation_distributor_id_idx" ON "quotation"("distributor_id");

-- CreateIndex
CREATE INDEX "quotation_customer_id_idx" ON "quotation"("customer_id");

-- CreateIndex
CREATE INDEX "quotation_group_id_revision_idx" ON "quotation"("group_id", "revision");

-- CreateIndex
CREATE INDEX "quotation_created_at_id_idx" ON "quotation"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "quotation_deleted_at_idx" ON "quotation"("deleted_at");

-- CreateIndex
CREATE INDEX "quotation_line_product_id_idx" ON "quotation_line"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_line_quotation_id_line_number_key" ON "quotation_line"("quotation_id", "line_number");

-- CreateIndex
CREATE UNIQUE INDEX "order_number_key" ON "order"("number");

-- CreateIndex
CREATE INDEX "order_status_order_date_idx" ON "order"("status", "order_date" DESC);

-- CreateIndex
CREATE INDEX "order_distributor_id_status_idx" ON "order"("distributor_id", "status");

-- CreateIndex
CREATE INDEX "order_customer_id_idx" ON "order"("customer_id");

-- CreateIndex
CREATE INDEX "order_quotation_id_idx" ON "order"("quotation_id");

-- CreateIndex
CREATE INDEX "order_created_at_id_idx" ON "order"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "order_deleted_at_idx" ON "order"("deleted_at");

-- CreateIndex
CREATE INDEX "order_line_product_id_idx" ON "order_line"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_line_order_id_line_number_key" ON "order_line"("order_id", "line_number");

-- CreateIndex
CREATE INDEX "order_approval_order_id_created_at_idx" ON "order_approval"("order_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "shipment_number_key" ON "shipment"("number");

-- CreateIndex
CREATE INDEX "shipment_order_id_status_idx" ON "shipment"("order_id", "status");

-- CreateIndex
CREATE INDEX "shipment_status_dispatched_at_idx" ON "shipment"("status", "dispatched_at" DESC);

-- CreateIndex
CREATE INDEX "shipment_created_at_id_idx" ON "shipment"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "shipment_deleted_at_idx" ON "shipment"("deleted_at");

-- CreateIndex
CREATE INDEX "shipment_line_order_line_id_idx" ON "shipment_line"("order_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_line_shipment_id_order_line_id_key" ON "shipment_line"("shipment_id", "order_line_id");

-- CreateIndex
CREATE INDEX "order_timeline_order_id_created_at_idx" ON "order_timeline"("order_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_territory_id_fkey" FOREIGN KEY ("territory_id") REFERENCES "territory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_industry_id_fkey" FOREIGN KEY ("industry_id") REFERENCES "industry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_billing_address_id_fkey" FOREIGN KEY ("billing_address_id") REFERENCES "address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_shipping_address_id_fkey" FOREIGN KEY ("shipping_address_id") REFERENCES "address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contact" ADD CONSTRAINT "customer_contact_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_line" ADD CONSTRAINT "quotation_line_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_line" ADD CONSTRAINT "quotation_line_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_line" ADD CONSTRAINT "quotation_line_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_approval" ADD CONSTRAINT "order_approval_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_line" ADD CONSTRAINT "shipment_line_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_line" ADD CONSTRAINT "shipment_line_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "order_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_timeline" ADD CONSTRAINT "order_timeline_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- 0008b — Sales guarantees Prisma's schema language cannot express.
--
-- Phase 7 owns two invariants from docs/00 §4.2: a distributor cannot exceed
-- its credit limit without an audited override, and stock cannot be dispatched
-- that is not on hand and reserved. Those are enforced in services because they
-- need context the database does not have. What IS expressible here is the
-- arithmetic that must never be violated regardless of which service wrote it.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Approvals and the timeline are append-only ──────────────────────────────
-- An approval is a statement a person made at a moment. Editing it destroys the
-- record of who authorised a concession — which is the entire reason the row
-- exists. Same reasoning as audit_log (0002) and stock_ledger_entry (0007).
CREATE OR REPLACE FUNCTION sales_record_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted. Record a new entry instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_approval_no_update
  BEFORE UPDATE ON "order_approval"
  FOR EACH ROW EXECUTE FUNCTION sales_record_is_append_only();
CREATE TRIGGER order_approval_no_delete
  BEFORE DELETE ON "order_approval"
  FOR EACH ROW EXECUTE FUNCTION sales_record_is_append_only();

CREATE TRIGGER order_timeline_no_update
  BEFORE UPDATE ON "order_timeline"
  FOR EACH ROW EXECUTE FUNCTION sales_record_is_append_only();
CREATE TRIGGER order_timeline_no_delete
  BEFORE DELETE ON "order_timeline"
  FOR EACH ROW EXECUTE FUNCTION sales_record_is_append_only();


-- ── Line quantities ─────────────────────────────────────────────────────────
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "quotation_line" ADD CONSTRAINT "quotation_line_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "shipment_line" ADD CONSTRAINT "shipment_line_quantity_positive"
  CHECK ("quantity" > 0);

-- ADR-0012: approval reserves what it can and backorders the rest, so these
-- three must always account for exactly what was ordered and no more. A line
-- promising more than the customer asked for is a bug that would surface as an
-- over-dispatch.
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_quantities_non_negative"
  CHECK (
    "quantity_reserved" >= 0
    AND "quantity_backordered" >= 0
    AND "quantity_dispatched" >= 0
  );

ALTER TABLE "order_line" ADD CONSTRAINT "order_line_promise_within_order"
  CHECK ("quantity_reserved" + "quantity_backordered" <= "quantity");

-- Invariant 2's last line of defence: you cannot ship more than was ordered.
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_dispatch_within_order"
  CHECK ("quantity_dispatched" <= "quantity");


-- ── Money is never negative on a sales document ─────────────────────────────
-- A negative total means a credit note, which is a different document type
-- entirely (Phase 8). Allowing one here would let a credit be raised without
-- any of the controls a credit note carries.
ALTER TABLE "order" ADD CONSTRAINT "order_totals_non_negative"
  CHECK (
    "subtotal" >= 0 AND "taxable_value" >= 0 AND "total_tax" >= 0 AND "grand_total" >= 0
  );

ALTER TABLE "quotation" ADD CONSTRAINT "quotation_totals_non_negative"
  CHECK (
    "subtotal" >= 0 AND "taxable_value" >= 0 AND "total_tax" >= 0 AND "grand_total" >= 0
  );

ALTER TABLE "order_line" ADD CONSTRAINT "order_line_prices_non_negative"
  CHECK ("unit_price" >= 0 AND "unit_list_price" >= 0 AND "line_total" >= 0);

ALTER TABLE "quotation_line" ADD CONSTRAINT "quotation_line_prices_non_negative"
  CHECK ("unit_price" >= 0 AND "unit_list_price" >= 0 AND "line_total" >= 0);


-- ── A credit override must state why ────────────────────────────────────────
-- The override flag and its reason travel together or the exception is
-- unexplainable, which defeats the point of recording it on the order.
ALTER TABLE "order" ADD CONSTRAINT "order_credit_override_needs_reason"
  CHECK ("credit_overridden" = false OR "credit_override_reason" IS NOT NULL);


-- ── Quotation revisions ─────────────────────────────────────────────────────
-- One revision number per quotation group. Two "rev 3"s of the same quotation
-- would make it impossible to say which document the customer is holding.
CREATE UNIQUE INDEX "quotation_group_revision_idx"
  ON "quotation" ("group_id", "revision")
  WHERE "deleted_at" IS NULL;

ALTER TABLE "quotation" ADD CONSTRAINT "quotation_validity_after_date"
  CHECK ("valid_until" IS NULL OR "valid_until" >= "quotation_date");


-- ── An order belongs to a distributor OR a customer, per its type ───────────
-- PRIMARY is Hixaa → distributor (sell-in); SECONDARY is distributor →
-- customer (sell-out). An order with neither counterparty is meaningless, and
-- mixing them up would put sell-out revenue in the sell-in ledger.
ALTER TABLE "order" ADD CONSTRAINT "order_counterparty_matches_type"
  CHECK (
    ("type" = 'PRIMARY'   AND "distributor_id" IS NOT NULL)
    OR ("type" = 'SECONDARY' AND "customer_id" IS NOT NULL)
  );


-- ── Hot paths ───────────────────────────────────────────────────────────────
-- Orders awaiting action: the approval queue, read on every dashboard load.
CREATE INDEX "order_pending_approval_idx"
  ON "order" ("created_at" DESC)
  WHERE "status" = 'PENDING_APPROVAL' AND "deleted_at" IS NULL;

-- Open orders drive credit exposure (§6 of docs/21) and the fulfilment list.
CREATE INDEX "order_open_idx"
  ON "order" ("distributor_id", "status")
  WHERE "status" IN ('APPROVED', 'PROCESSING', 'PARTIALLY_DISPATCHED') AND "deleted_at" IS NULL;

-- Lines still owing stock — the backorder report.
CREATE INDEX "order_line_backordered_idx"
  ON "order_line" ("product_id", "expected_available_date")
  WHERE "quantity_backordered" > 0;

-- Live quotations for the follow-up list.
CREATE INDEX "quotation_open_idx"
  ON "quotation" ("valid_until")
  WHERE "status" IN ('DRAFT', 'SENT') AND "deleted_at" IS NULL;
