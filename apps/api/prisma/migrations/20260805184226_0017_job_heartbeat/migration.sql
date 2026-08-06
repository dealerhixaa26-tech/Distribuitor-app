-- CreateEnum
CREATE TYPE "HeartbeatStatus" AS ENUM ('ALIVE', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "job_heartbeat" (
    "name" TEXT NOT NULL,
    "status" "HeartbeatStatus" NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "last_success_at" TIMESTAMPTZ(3),
    "last_duration_ms" INTEGER,
    "last_error" TEXT,
    "stale_after_seconds" INTEGER NOT NULL,
    "booted_at" TIMESTAMPTZ(3),
    "version" TEXT,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_heartbeat_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "job_heartbeat_last_seen_at_idx" ON "job_heartbeat"("last_seen_at");
