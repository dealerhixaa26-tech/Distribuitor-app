-- ═══════════════════════════════════════════════════════════════════════════
-- 0012 — the ledger's party becomes two foreign keys.
--
-- `ledger_entry` shipped in 0010 with `party_type` + `party_id`, which reads
-- well and CANNOT BE SCOPED. `party_id` deliberately points at one of two
-- tables, so it has no relation for the scope extension to nest through, and
-- Prisma offers no correlated subquery to fall back on. The alternative was
-- resolving every visible distributor and customer id on each request, to
-- support a model that is read on one screen.
--
-- So the party is now two nullable FKs with a CHECK that exactly one is set —
-- the same shape `invoice` and `payment` already use — and
-- `viaDistributorOrCustomer()`, written for orders in Phase 7, applies
-- unchanged. The DISTRIBUTOR | CUSTOMER vocabulary survives in
-- `@hixaa/contracts` as the API's shape; the service derives it from the
-- columns.
--
-- Safe to run destructively: `ledger_entry` held zero rows, because Phase 8 has
-- not been released. Were that not true this would need a backfill, and the
-- append-only trigger would have to be dropped and recreated around it.
-- ═══════════════════════════════════════════════════════════════════════════

/*
  Warnings:

  - You are about to drop the column `party_id` on the `ledger_entry` table. All the data in the column will be lost.
  - You are about to drop the column `party_type` on the `ledger_entry` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "ledger_entry_party_type_party_id_entry_date_id_idx";

-- AlterTable
ALTER TABLE "ledger_entry" DROP COLUMN "party_id",
DROP COLUMN "party_type",
ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "distributor_id" UUID;

-- DropEnum
DROP TYPE "LedgerPartyType";

-- CreateIndex
CREATE INDEX "ledger_entry_distributor_id_entry_date_id_idx" ON "ledger_entry"("distributor_id", "entry_date", "id");

-- CreateIndex
CREATE INDEX "ledger_entry_customer_id_entry_date_id_idx" ON "ledger_entry"("customer_id", "entry_date", "id");

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one party, mirroring `invoice_exactly_one_counterparty`. A ledger row
-- belonging to nobody, or to two parties at once, is a balance that cannot be
-- attributed — and attribution is the entire purpose of a party ledger.
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_exactly_one_party"
  CHECK (("distributor_id" IS NULL) <> ("customer_id" IS NULL));
