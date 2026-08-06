-- CreateEnum
CREATE TYPE "SyncTarget" AS ENUM ('GOOGLE_SHEETS');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('EXPORT', 'RESTORE');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "sync_job" (
    "id" UUID NOT NULL,
    "target" "SyncTarget" NOT NULL DEFAULT 'GOOGLE_SHEETS',
    "direction" "SyncDirection" NOT NULL DEFAULT 'EXPORT',
    "entity" TEXT NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'QUEUED',
    "checkpoint_cursor" TEXT,
    "rows_processed" INTEGER NOT NULL DEFAULT 0,
    "rows_expected" INTEGER,
    "batches_written" INTEGER NOT NULL DEFAULT 0,
    "spreadsheet_id" TEXT,
    "sheet_title" TEXT,
    "is_dry_run" BOOLEAN NOT NULL DEFAULT true,
    "diff_summary" JSONB,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "error" TEXT,
    "api_requests" INTEGER NOT NULL DEFAULT 0,
    "is_scheduled" BOOLEAN NOT NULL DEFAULT false,
    "triggered_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sync_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_job_status_created_at_idx" ON "sync_job"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sync_job_entity_created_at_idx" ON "sync_job"("entity", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sync_job_direction_status_idx" ON "sync_job"("direction", "status");

-- AddForeignKey
ALTER TABLE "sync_job" ADD CONSTRAINT "sync_job_triggered_by_id_fkey" FOREIGN KEY ("triggered_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
