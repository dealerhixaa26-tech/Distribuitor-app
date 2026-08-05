-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('SALES_SUMMARY', 'DISTRIBUTOR_PERFORMANCE', 'PRODUCT_PERFORMANCE', 'STOCK_VALUATION', 'RECEIVABLES_AGING', 'GST_SUMMARY');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('CSV', 'XLSX', 'PDF');

-- CreateEnum
CREATE TYPE "ReportRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "TargetPeriodType" AS ENUM ('MONTH', 'QUARTER', 'YEAR');

-- CreateTable
CREATE TABLE "report_definition" (
    "id" UUID NOT NULL,
    "type" "ReportType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "format" "ReportFormat" NOT NULL DEFAULT 'CSV',
    "is_shared" BOOLEAN NOT NULL DEFAULT false,
    "cron_expression" TEXT,
    "recipients" TEXT[],
    "is_schedule_active" BOOLEAN NOT NULL DEFAULT false,
    "last_run_at" TIMESTAMPTZ(3),
    "next_run_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,

    CONSTRAINT "report_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_run" (
    "id" UUID NOT NULL,
    "definition_id" UUID,
    "type" "ReportType" NOT NULL,
    "status" "ReportRunStatus" NOT NULL DEFAULT 'QUEUED',
    "format" "ReportFormat" NOT NULL,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "row_count" INTEGER,
    "document_id" UUID,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "error" TEXT,
    "is_scheduled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "report_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_target" (
    "id" UUID NOT NULL,
    "period_type" "TargetPeriodType" NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "territory_id" UUID,
    "distributor_id" UUID,
    "product_id" UUID,
    "target_amount" DECIMAL(18,4) NOT NULL,
    "target_quantity" DECIMAL(18,4),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,

    CONSTRAINT "sales_target_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_definition_type_idx" ON "report_definition"("type");

-- CreateIndex
CREATE INDEX "report_definition_created_by_id_idx" ON "report_definition"("created_by_id");

-- CreateIndex
CREATE INDEX "report_definition_is_schedule_active_next_run_at_idx" ON "report_definition"("is_schedule_active", "next_run_at");

-- CreateIndex
CREATE INDEX "report_definition_created_at_id_idx" ON "report_definition"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "report_definition_deleted_at_idx" ON "report_definition"("deleted_at");

-- CreateIndex
CREATE INDEX "report_run_definition_id_created_at_idx" ON "report_run"("definition_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "report_run_status_idx" ON "report_run"("status");

-- CreateIndex
CREATE INDEX "report_run_created_at_id_idx" ON "report_run"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "sales_target_period_start_period_end_idx" ON "sales_target"("period_start", "period_end");

-- CreateIndex
CREATE INDEX "sales_target_territory_id_period_start_idx" ON "sales_target"("territory_id", "period_start");

-- CreateIndex
CREATE INDEX "sales_target_distributor_id_period_start_idx" ON "sales_target"("distributor_id", "period_start");

-- CreateIndex
CREATE INDEX "sales_target_product_id_period_start_idx" ON "sales_target"("product_id", "period_start");

-- CreateIndex
CREATE INDEX "sales_target_deleted_at_idx" ON "sales_target"("deleted_at");

-- AddForeignKey
ALTER TABLE "report_definition" ADD CONSTRAINT "report_definition_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_run" ADD CONSTRAINT "report_run_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "report_definition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_run" ADD CONSTRAINT "report_run_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_target" ADD CONSTRAINT "sales_target_territory_id_fkey" FOREIGN KEY ("territory_id") REFERENCES "territory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_target" ADD CONSTRAINT "sales_target_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_target" ADD CONSTRAINT "sales_target_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Indexes justified by MEASUREMENT, not by intuition.
--
-- Phase 9 timed every dashboard aggregate at ten times a generous three-year
-- projection (30,000 orders / 120,000 order lines) before deciding anything.
-- Full numbers in ADR-0019. Only the two indexes that actually moved a panel
-- are here — an index nobody measured is a write cost nobody accounted for.
-- ═══════════════════════════════════════════════════════════════════════════

-- The aging and revenue panels filter orders by date and exclude dead statuses.
-- Took the receivables panel from 19.9 ms to 9.9 ms at 10x volume.
--
-- PARTIAL, which is also why Prisma will not propose dropping it: it skips what
-- it cannot model (HANDOFF §4.13). The excluded statuses are exactly the orders
-- that represent no revenue.
CREATE INDEX "order_analytics_idx"
  ON "order" ("order_date" DESC, "type", "status")
  WHERE "status" NOT IN ('DRAFT', 'CANCELLED', 'REJECTED');

-- Covering index for the line-level aggregates (sales trend, top products), so
-- the rollup reads the index rather than the heap.
--
-- Note from the measurement: this does NOT rescue those two panels — they still
-- take ~40 ms at 10x because they genuinely have to aggregate 120,000 line
-- rows, and no index removes that work. It is here because it helps somewhat
-- and costs one index; it is NOT here because it solved the problem.
CREATE INDEX "order_line_rollup_idx"
  ON "order_line" ("order_id")
  INCLUDE ("line_total", "quantity", "product_id");

-- Invoice-line equivalent, for revenue reports that read from what was actually
-- billed rather than what was ordered.
CREATE INDEX "invoice_line_rollup_idx"
  ON "invoice_line" ("invoice_id")
  INCLUDE ("line_total", "quantity", "product_id", "taxable_value");

-- ── A sales target measures exactly ONE dimension ──────────────────────────
-- Territory, distributor, or product — never two at once. A target against two
-- dimensions is ambiguous about what it measures, and the ambiguity only
-- surfaces later when the achievement figure looks wrong and nobody can say
-- which denominator it used.
ALTER TABLE "sales_target" ADD CONSTRAINT "sales_target_exactly_one_dimension"
  CHECK (
    (CASE WHEN "territory_id"   IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "distributor_id" IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "product_id"     IS NOT NULL THEN 1 ELSE 0 END) = 1
  );

ALTER TABLE "sales_target" ADD CONSTRAINT "sales_target_period_ordered"
  CHECK ("period_end" >= "period_start");

ALTER TABLE "sales_target" ADD CONSTRAINT "sales_target_amount_positive"
  CHECK ("target_amount" > 0);

-- One target per dimension per period. A second would silently double the
-- denominator of every achievement percentage.
CREATE UNIQUE INDEX "sales_target_territory_period_key"
  ON "sales_target" ("territory_id", "period_start", "period_end")
  WHERE "territory_id" IS NOT NULL AND "deleted_at" IS NULL;

CREATE UNIQUE INDEX "sales_target_distributor_period_key"
  ON "sales_target" ("distributor_id", "period_start", "period_end")
  WHERE "distributor_id" IS NOT NULL AND "deleted_at" IS NULL;

CREATE UNIQUE INDEX "sales_target_product_period_key"
  ON "sales_target" ("product_id", "period_start", "period_end")
  WHERE "product_id" IS NOT NULL AND "deleted_at" IS NULL;

-- ── A scheduled report needs somewhere to send it ──────────────────────────
-- An active schedule with no recipients runs forever and reaches nobody, which
-- looks like a working report right up until someone asks where it went.
ALTER TABLE "report_definition" ADD CONSTRAINT "report_schedule_needs_recipients"
  CHECK (
    "is_schedule_active" = false
    OR ("cron_expression" IS NOT NULL AND array_length("recipients", 1) >= 1)
  );
