-- CreateEnum
CREATE TYPE "DistributorType" AS ENUM ('DISTRIBUTOR', 'DEALER', 'SYSTEM_INTEGRATOR', 'OEM_PARTNER');

-- CreateEnum
CREATE TYPE "DistributorStatus" AS ENUM ('LEAD', 'PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "KycDocumentType" AS ENUM ('GST_CERTIFICATE', 'PAN_CARD', 'AGREEMENT', 'CANCELLED_CHEQUE', 'MSME_CERT', 'OTHER');

-- CreateEnum
CREATE TYPE "AgreementStatus" AS ENUM ('DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED');

-- CreateTable
CREATE TABLE "distributor" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "trade_name" TEXT,
    "type" "DistributorType" NOT NULL DEFAULT 'DISTRIBUTOR',
    "status" "DistributorStatus" NOT NULL DEFAULT 'LEAD',
    "territory_id" UUID,
    "account_manager_id" UUID,
    "price_list_id" UUID,
    "billing_address_id" UUID,
    "shipping_address_id" UUID,
    "gstin" TEXT,
    "pan" TEXT,
    "tan" TEXT,
    "cin" TEXT,
    "msme_number" TEXT,
    "credit_limit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "credit_days" INTEGER NOT NULL DEFAULT 30,
    "opening_balance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "payment_terms_code" TEXT,
    "bank_account_name" TEXT,
    "bank_account_encrypted" TEXT,
    "bank_ifsc" TEXT,
    "bank_name" TEXT,
    "website" TEXT,
    "tags" TEXT[],
    "onboarded_at" TIMESTAMPTZ(3),
    "suspended_at" TIMESTAMPTZ(3),
    "status_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "updated_by_id" UUID,

    CONSTRAINT "distributor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distributor_contact" (
    "id" UUID NOT NULL,
    "distributor_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "designation" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "portal_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "distributor_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distributor_document" (
    "id" UUID NOT NULL,
    "distributor_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "type" "KycDocumentType" NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "verified_at" TIMESTAMPTZ(3),
    "verified_by_id" UUID,
    "rejected_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "distributor_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distributor_note" (
    "id" UUID NOT NULL,
    "distributor_id" UUID NOT NULL,
    "author_id" UUID,
    "body" TEXT NOT NULL,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "distributor_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agreement" (
    "id" UUID NOT NULL,
    "distributor_id" UUID NOT NULL,
    "reference" TEXT,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "target_amount" DECIMAL(18,4),
    "status" "AgreementStatus" NOT NULL DEFAULT 'DRAFT',
    "document_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "agreement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "distributor_code_key" ON "distributor"("code");

-- CreateIndex
CREATE UNIQUE INDEX "distributor_gstin_key" ON "distributor"("gstin");

-- CreateIndex
CREATE INDEX "distributor_status_territory_id_idx" ON "distributor"("status", "territory_id");

-- CreateIndex
CREATE INDEX "distributor_account_manager_id_idx" ON "distributor"("account_manager_id");

-- CreateIndex
CREATE INDEX "distributor_territory_id_idx" ON "distributor"("territory_id");

-- CreateIndex
CREATE INDEX "distributor_created_at_id_idx" ON "distributor"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "distributor_deleted_at_idx" ON "distributor"("deleted_at");

-- CreateIndex
CREATE INDEX "distributor_contact_distributor_id_idx" ON "distributor_contact"("distributor_id");

-- CreateIndex
CREATE INDEX "distributor_contact_portal_user_id_idx" ON "distributor_contact"("portal_user_id");

-- CreateIndex
CREATE INDEX "distributor_document_distributor_id_type_idx" ON "distributor_document"("distributor_id", "type");

-- CreateIndex
CREATE INDEX "distributor_document_expires_at_idx" ON "distributor_document"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "distributor_document_distributor_id_type_document_id_key" ON "distributor_document"("distributor_id", "type", "document_id");

-- CreateIndex
CREATE INDEX "distributor_note_distributor_id_is_pinned_created_at_idx" ON "distributor_note"("distributor_id", "is_pinned", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agreement_distributor_id_status_idx" ON "agreement"("distributor_id", "status");

-- CreateIndex
CREATE INDEX "agreement_end_date_idx" ON "agreement"("end_date");

-- AddForeignKey
ALTER TABLE "distributor" ADD CONSTRAINT "distributor_territory_id_fkey" FOREIGN KEY ("territory_id") REFERENCES "territory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributor" ADD CONSTRAINT "distributor_account_manager_id_fkey" FOREIGN KEY ("account_manager_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributor" ADD CONSTRAINT "distributor_billing_address_id_fkey" FOREIGN KEY ("billing_address_id") REFERENCES "address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributor" ADD CONSTRAINT "distributor_shipping_address_id_fkey" FOREIGN KEY ("shipping_address_id") REFERENCES "address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributor_contact" ADD CONSTRAINT "distributor_contact_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributor_document" ADD CONSTRAINT "distributor_document_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributor_document" ADD CONSTRAINT "distributor_document_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributor_note" ADD CONSTRAINT "distributor_note_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributor_note" ADD CONSTRAINT "distributor_note_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement" ADD CONSTRAINT "agreement_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement" ADD CONSTRAINT "agreement_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
