-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupplyType" AS ENUM ('B2B', 'B2CL', 'B2CS', 'EXPORT', 'SEZ');

-- CreateEnum
CREATE TYPE "TaxNoteType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "TaxNoteStatus" AS ENUM ('DRAFT', 'ISSUED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaxNoteReason" AS ENUM ('SALES_RETURN', 'RATE_DIFFERENCE', 'QUANTITY_DIFFERENCE', 'POST_SALE_DISCOUNT', 'DEFICIENCY_IN_SERVICE', 'TAX_CORRECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CHEQUE', 'NEFT', 'RTGS', 'IMPS', 'UPI', 'DEMAND_DRAFT', 'CARD', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('RECORDED', 'VERIFIED', 'BOUNCED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LedgerPartyType" AS ENUM ('DISTRIBUTOR', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('OPENING_BALANCE', 'INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE', 'PAYMENT', 'TDS', 'WRITE_OFF', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "number_sequence" ADD COLUMN     "separator" TEXT NOT NULL DEFAULT '-';

-- CreateTable
CREATE TABLE "invoice" (
    "id" UUID NOT NULL,
    "number" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "distributor_id" UUID,
    "customer_id" UUID,
    "order_id" UUID,
    "supplier_state_code" TEXT NOT NULL,
    "place_of_supply_state_code" TEXT NOT NULL,
    "supply_type" "SupplyType" NOT NULL DEFAULT 'B2B',
    "is_reverse_charge" BOOLEAN NOT NULL DEFAULT false,
    "counterparty_name" TEXT NOT NULL,
    "counterparty_gstin" TEXT,
    "billing_address_id" UUID,
    "shipping_address_id" UUID,
    "invoice_date" DATE NOT NULL,
    "due_date" DATE,
    "payment_terms_code" TEXT,
    "customer_po_number" TEXT,
    "customer_po_date" DATE,
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_discount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxable_value" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_cgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_sgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_igst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_cess" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_tax" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "round_off" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "amount_paid" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "amount_credited" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "amount_outstanding" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "terms_and_conditions" TEXT,
    "issued_at" TIMESTAMPTZ(3),
    "issued_by_id" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancelled_reason" TEXT,
    "irn" TEXT,
    "ack_number" TEXT,
    "ack_date" TIMESTAMPTZ(3),
    "signed_qr_code" TEXT,
    "eway_bill_number" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by_id" UUID,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "order_line_id" UUID,
    "sku" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "product_revision" INTEGER NOT NULL DEFAULT 1,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom_code" TEXT,
    "unit_list_price" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "discount_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "discount_percent" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "taxable_value" DECIMAL(18,4) NOT NULL,
    "hsn_sac_code" TEXT,
    "gst_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cess_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "igst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "cess" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_tax" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,4) NOT NULL,
    "tax_rate_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_note" (
    "id" UUID NOT NULL,
    "type" "TaxNoteType" NOT NULL,
    "number" TEXT,
    "status" "TaxNoteStatus" NOT NULL DEFAULT 'DRAFT',
    "original_invoice_id" UUID NOT NULL,
    "reason" "TaxNoteReason" NOT NULL,
    "reason_note" TEXT,
    "supplier_state_code" TEXT NOT NULL,
    "place_of_supply_state_code" TEXT NOT NULL,
    "counterparty_name" TEXT NOT NULL,
    "counterparty_gstin" TEXT,
    "note_date" DATE NOT NULL,
    "taxable_value" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_cgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_sgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_igst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_cess" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_tax" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "round_off" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "issued_at" TIMESTAMPTZ(3),
    "issued_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by_id" UUID,

    CONSTRAINT "tax_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_note_line" (
    "id" UUID NOT NULL,
    "tax_note_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "invoice_line_id" UUID,
    "product_id" UUID,
    "sku" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4),
    "uom_code" TEXT,
    "unit_price" DECIMAL(18,4),
    "taxable_value" DECIMAL(18,4) NOT NULL,
    "hsn_sac_code" TEXT,
    "gst_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cess_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "igst" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "cess" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_tax" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,4) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tax_note_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'RECORDED',
    "distributor_id" UUID,
    "customer_id" UUID,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "tds_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unallocated_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "payment_date" DATE NOT NULL,
    "reference_number" TEXT,
    "bank_name" TEXT,
    "cheque_number" TEXT,
    "cheque_date" DATE,
    "notes" TEXT,
    "recorded_by_id" UUID NOT NULL,
    "verified_by_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "bounced_at" TIMESTAMPTZ(3),
    "bounced_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocation" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "tds_portion" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "payment_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entry" (
    "id" UUID NOT NULL,
    "party_type" "LedgerPartyType" NOT NULL,
    "party_id" UUID NOT NULL,
    "entry_type" "LedgerEntryType" NOT NULL,
    "debit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "ref_type" TEXT,
    "ref_id" UUID,
    "ref_number" TEXT,
    "reverses_id" UUID,
    "entry_date" DATE NOT NULL,
    "narration" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_number_key" ON "invoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_irn_key" ON "invoice"("irn");

-- CreateIndex
CREATE INDEX "invoice_status_due_date_idx" ON "invoice"("status", "due_date");

-- CreateIndex
CREATE INDEX "invoice_distributor_id_status_idx" ON "invoice"("distributor_id", "status");

-- CreateIndex
CREATE INDEX "invoice_customer_id_status_idx" ON "invoice"("customer_id", "status");

-- CreateIndex
CREATE INDEX "invoice_order_id_idx" ON "invoice"("order_id");

-- CreateIndex
CREATE INDEX "invoice_invoice_date_id_idx" ON "invoice"("invoice_date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "invoice_created_at_id_idx" ON "invoice"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "invoice_line_product_id_idx" ON "invoice_line"("product_id");

-- CreateIndex
CREATE INDEX "invoice_line_order_line_id_idx" ON "invoice_line"("order_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_line_invoice_id_line_number_key" ON "invoice_line"("invoice_id", "line_number");

-- CreateIndex
CREATE UNIQUE INDEX "tax_note_number_key" ON "tax_note"("number");

-- CreateIndex
CREATE INDEX "tax_note_original_invoice_id_idx" ON "tax_note"("original_invoice_id");

-- CreateIndex
CREATE INDEX "tax_note_type_status_note_date_idx" ON "tax_note"("type", "status", "note_date" DESC);

-- CreateIndex
CREATE INDEX "tax_note_note_date_id_idx" ON "tax_note"("note_date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "tax_note_line_invoice_line_id_idx" ON "tax_note_line"("invoice_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "tax_note_line_tax_note_id_line_number_key" ON "tax_note_line"("tax_note_id", "line_number");

-- CreateIndex
CREATE UNIQUE INDEX "payment_number_key" ON "payment"("number");

-- CreateIndex
CREATE INDEX "payment_status_payment_date_idx" ON "payment"("status", "payment_date" DESC);

-- CreateIndex
CREATE INDEX "payment_distributor_id_status_idx" ON "payment"("distributor_id", "status");

-- CreateIndex
CREATE INDEX "payment_customer_id_status_idx" ON "payment"("customer_id", "status");

-- CreateIndex
CREATE INDEX "payment_created_at_id_idx" ON "payment"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "payment_allocation_invoice_id_idx" ON "payment_allocation"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocation_payment_id_invoice_id_key" ON "payment_allocation"("payment_id", "invoice_id");

-- CreateIndex
CREATE INDEX "ledger_entry_party_type_party_id_entry_date_id_idx" ON "ledger_entry"("party_type", "party_id", "entry_date", "id");

-- CreateIndex
CREATE INDEX "ledger_entry_ref_type_ref_id_idx" ON "ledger_entry"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "ledger_entry_entry_type_idx" ON "ledger_entry"("entry_type");

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "order_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_note" ADD CONSTRAINT "tax_note_original_invoice_id_fkey" FOREIGN KEY ("original_invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_note_line" ADD CONSTRAINT "tax_note_line_tax_note_id_fkey" FOREIGN KEY ("tax_note_id") REFERENCES "tax_note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_note_line" ADD CONSTRAINT "tax_note_line_invoice_line_id_fkey" FOREIGN KEY ("invoice_line_id") REFERENCES "invoice_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_note_line" ADD CONSTRAINT "tax_note_line_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8 controls that live in the DATABASE, not in a service.
--
-- A service check protects the one code path it sits on. It does not protect a
-- batch job, a data-fix script, or someone in psql at 11pm — and this codebase
-- has twice shipped a control that typechecked and silently did nothing
-- (HANDOFF §4.1, §4.14). For a legal document that is not an acceptable
-- failure mode. See ADR-0015 and ADR-0016.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The party ledger is append-only ─────────────────────────────────────
-- Same guarantee `stock_ledger_entry` has had since migration 0007. A mistake
-- is corrected by a CONTRA entry so the wrong row stays visible; a ledger you
-- can edit is not a ledger.

CREATE OR REPLACE FUNCTION ledger_entry_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entry is append-only: % is not permitted. Post a contra entry (reverses_id) instead.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entry_no_update
  BEFORE UPDATE ON "ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_is_append_only();

CREATE TRIGGER ledger_entry_no_delete
  BEFORE DELETE ON "ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_is_append_only();

-- Exactly one side. A row with both, or neither, has no meaning — and the
-- check costs nothing next to the "why doesn't the statement balance"
-- investigation it prevents.
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_exactly_one_side"
  CHECK (("debit" = 0) <> ("credit" = 0));

ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_sides_non_negative"
  CHECK ("debit" >= 0 AND "credit" >= 0);

-- ── 2. An issued invoice is frozen (ADR-0016) ──────────────────────────────
-- Twenty-one columns: everything a reader of the printed document would
-- recognise as the document. Settlement columns stay writable, because an
-- invoice whose paid amount can never change is not immutable, it is unusable.
--
-- The rule: the CLAIM is frozen; the HISTORY of the claim is not.

CREATE OR REPLACE FUNCTION invoice_is_immutable_once_issued()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  IF NEW."number"                     IS DISTINCT FROM OLD."number"
  OR NEW."invoice_date"               IS DISTINCT FROM OLD."invoice_date"
  OR NEW."due_date"                   IS DISTINCT FROM OLD."due_date"
  OR NEW."place_of_supply_state_code" IS DISTINCT FROM OLD."place_of_supply_state_code"
  OR NEW."supplier_state_code"        IS DISTINCT FROM OLD."supplier_state_code"
  OR NEW."distributor_id"             IS DISTINCT FROM OLD."distributor_id"
  OR NEW."customer_id"                IS DISTINCT FROM OLD."customer_id"
  OR NEW."order_id"                   IS DISTINCT FROM OLD."order_id"
  OR NEW."supply_type"                IS DISTINCT FROM OLD."supply_type"
  OR NEW."is_reverse_charge"          IS DISTINCT FROM OLD."is_reverse_charge"
  OR NEW."counterparty_gstin"         IS DISTINCT FROM OLD."counterparty_gstin"
  OR NEW."subtotal"                   IS DISTINCT FROM OLD."subtotal"
  OR NEW."total_discount"             IS DISTINCT FROM OLD."total_discount"
  OR NEW."taxable_value"              IS DISTINCT FROM OLD."taxable_value"
  OR NEW."total_cgst"                 IS DISTINCT FROM OLD."total_cgst"
  OR NEW."total_sgst"                 IS DISTINCT FROM OLD."total_sgst"
  OR NEW."total_igst"                 IS DISTINCT FROM OLD."total_igst"
  OR NEW."total_cess"                 IS DISTINCT FROM OLD."total_cess"
  OR NEW."total_tax"                  IS DISTINCT FROM OLD."total_tax"
  OR NEW."round_off"                  IS DISTINCT FROM OLD."round_off"
  OR NEW."grand_total"                IS DISTINCT FROM OLD."grand_total"
  THEN
    RAISE EXCEPTION
      'Invoice % is % and its financial identity is frozen. Correct it with a credit or debit note (CGST s.34).',
      COALESCE(OLD."number", OLD."id"::text), OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_frozen_once_issued
  BEFORE UPDATE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION invoice_is_immutable_once_issued();

-- A line is entirely part of the document — there is no partial-write case for
-- one, so both operations are refused outright rather than column by column.
CREATE OR REPLACE FUNCTION invoice_line_is_immutable_once_issued()
RETURNS TRIGGER AS $$
DECLARE
  parent_status TEXT;
  parent_number TEXT;
BEGIN
  SELECT i."status"::text, i."number" INTO parent_status, parent_number
  FROM "invoice" i
  WHERE i."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."invoice_id" ELSE NEW."invoice_id" END;

  IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION
      'Invoice % is % — its lines cannot be % d. Correct it with a credit or debit note.',
      COALESCE(parent_number, '(draft)'), parent_status, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_line_frozen_once_issued
  BEFORE UPDATE OR DELETE ON "invoice_line"
  FOR EACH ROW EXECUTE FUNCTION invoice_line_is_immutable_once_issued();

-- ── 3. amount_outstanding is derived, and cannot drift from its inputs ─────
-- A BEFORE trigger rather than a GENERATED column: Prisma diffs GENERATED
-- columns as drift and the next `migrate dev` proposes dropping them
-- (HANDOFF §4.13). Behaviourally identical, and the column looks ordinary to
-- the ORM.

CREATE OR REPLACE FUNCTION invoice_outstanding_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW."amount_outstanding" := NEW."grand_total" - NEW."amount_paid" - NEW."amount_credited";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_outstanding_trigger
  BEFORE INSERT OR UPDATE OF "grand_total", "amount_paid", "amount_credited"
  ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION invoice_outstanding_update();

-- An invoice cannot be over-settled. This is the constraint that would
-- otherwise let a double-allocated payment quietly create a negative
-- receivable — which reads as a credit balance nobody can explain.
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_not_over_settled"
  CHECK ("amount_paid" + "amount_credited" <= "grand_total");

ALTER TABLE "invoice" ADD CONSTRAINT "invoice_settlement_non_negative"
  CHECK ("amount_paid" >= 0 AND "grand_total" >= 0);

-- An ISSUED invoice must carry a number, and a DRAFT must not. This is what
-- makes "delete a draft freely" safe: no statutory number was ever consumed.
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_number_matches_status"
  CHECK (("status" = 'DRAFT') = ("number" IS NULL));

-- Exactly one counterparty. An invoice addressed to nobody, or to two parties,
-- is not a document that can be sent or a receivable that can be aged.
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_exactly_one_counterparty"
  CHECK (("distributor_id" IS NULL) <> ("customer_id" IS NULL));

-- ── 4. A payment cannot be over-allocated ──────────────────────────────────
-- The real control is the SELECT … FOR UPDATE in PaymentsService.allocate:
-- two concurrent allocations against one payment is a genuine race, and
-- check-then-write loses it exactly as check-then-lock lost the oversell race
-- StockLedgerService.move() was built to close (HANDOFF §4.15).
--
-- These constraints make the invariant explicit and the single-row case fast.
ALTER TABLE "payment" ADD CONSTRAINT "payment_amounts_non_negative"
  CHECK ("amount" >= 0 AND "tds_amount" >= 0 AND "unallocated_amount" >= 0);

ALTER TABLE "payment" ADD CONSTRAINT "payment_unallocated_within_total"
  CHECK ("unallocated_amount" <= "amount" + "tds_amount");

ALTER TABLE "payment" ADD CONSTRAINT "payment_exactly_one_party"
  CHECK (("distributor_id" IS NULL) <> ("customer_id" IS NULL));

-- The person who records a receipt must not be the person who confirms it.
-- Declared in SEGREGATION_OF_DUTIES since Phase 2 and enforced in the service;
-- also stated here, because the role rule cannot stop one PERSON holding two
-- roles and the service check protects only its own path (ADR-0018 §2).
ALTER TABLE "payment" ADD CONSTRAINT "payment_verifier_differs_from_recorder"
  CHECK ("verified_by_id" IS NULL OR "verified_by_id" <> "recorded_by_id");

ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_amount_positive"
  CHECK ("amount" > 0 AND "tds_portion" >= 0 AND "tds_portion" <= "amount");

-- ── 5. A tax note must carry value and, once issued, a number ─────────────
ALTER TABLE "tax_note" ADD CONSTRAINT "tax_note_number_matches_status"
  CHECK (("status" = 'DRAFT') = ("number" IS NULL));

ALTER TABLE "tax_note" ADD CONSTRAINT "tax_note_totals_non_negative"
  CHECK ("taxable_value" >= 0 AND "grand_total" >= 0);

-- ── 6. The aging index ─────────────────────────────────────────────────────
-- Partial, because a fully settled invoice is never in an aging bucket, and
-- because Prisma skips what it cannot model — so it will not propose dropping
-- this one (HANDOFF §4.13).
CREATE INDEX "invoice_outstanding_aging_idx"
  ON "invoice" ("due_date", "status")
  WHERE "amount_outstanding" > 0;

-- The GSTR-1 extraction reads a whole period of issued invoices and never
-- looks at drafts.
CREATE INDEX "invoice_issued_period_idx"
  ON "invoice" ("invoice_date", "supply_type")
  WHERE "status" <> 'DRAFT';
