-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('GLOBAL', 'TERRITORY', 'DISTRIBUTOR');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'API_KEY');

-- CreateEnum
CREATE TYPE "AuditCategory" AS ENUM ('AUTH', 'DATA', 'SECURITY', 'INTEGRATION');

-- CreateEnum
CREATE TYPE "MfaType" AS ENUM ('TOTP', 'BACKUP_CODE');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "MailChannel" AS ENUM ('BUSINESS', 'OPS');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "StorageProvider" AS ENUM ('LOCAL', 'S3');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "DocumentVisibility" AS ENUM ('PUBLIC', 'INTERNAL', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "NumberResetPolicy" AS ENUM ('NEVER', 'YEARLY', 'MONTHLY');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "phone" TEXT,
    "avatar_url" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "email_verified_at" TIMESTAMP(3),
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "password_changed_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "last_login_ip" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "updated_by_id" UUID,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope_type" "ScopeType" NOT NULL DEFAULT 'GLOBAL',
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "level" INTEGER NOT NULL DEFAULT 0,
    "max_discount_percent" DECIMAL(7,4),
    "max_order_value" DECIMAL(18,4),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "scope_type" "ScopeType" NOT NULL DEFAULT 'GLOBAL',
    "scope_id" UUID,
    "expires_at" TIMESTAMP(3),
    "assigned_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "replaced_by_id" UUID,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "remember_me" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_token" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_token" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_factor" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "MfaType" NOT NULL DEFAULT 'TOTP',
    "secret_encrypted" TEXT NOT NULL,
    "backup_codes" TEXT[],
    "confirmed_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_factor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "manager_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_member" (
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_member_pkey" PRIMARY KEY ("team_id","user_id")
);

-- CreateTable
CREATE TABLE "api_key" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "permissions" TEXT[],
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_type" "ActorType" NOT NULL DEFAULT 'USER',
    "actor_label" TEXT,
    "category" "AuditCategory" NOT NULL DEFAULT 'DATA',
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "actor_user_id" UUID,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_log" (
    "id" UUID NOT NULL,
    "channel" "MailChannel" NOT NULL,
    "to_address" TEXT NOT NULL,
    "cc_address" TEXT[],
    "subject" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "provider_message_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "action_url" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preference" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "channels" "NotificationChannel"[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "provider" "StorageProvider" NOT NULL DEFAULT 'LOCAL',
    "original_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum_sha256" TEXT NOT NULL,
    "scan_status" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "scan_engine" TEXT,
    "scanned_at" TIMESTAMP(3),
    "visibility" "DocumentVisibility" NOT NULL DEFAULT 'INTERNAL',
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_link" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "purpose" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_setting" (
    "id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "is_secret" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_sequence" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "next_value" INTEGER NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 5,
    "financial_year" TEXT,
    "reset_policy" "NumberResetPolicy" NOT NULL DEFAULT 'YEARLY',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "number_sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "locked_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flag" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_status_deleted_at_idx" ON "user"("status", "deleted_at");

-- CreateIndex
CREATE INDEX "user_created_at_id_idx" ON "user"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "role_key_key" ON "role"("key");

-- CreateIndex
CREATE INDEX "role_deleted_at_idx" ON "role"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "permission_key_key" ON "permission"("key");

-- CreateIndex
CREATE INDEX "permission_resource_idx" ON "permission"("resource");

-- CreateIndex
CREATE INDEX "role_permission_permission_id_idx" ON "role_permission"("permission_id");

-- CreateIndex
CREATE INDEX "user_role_user_id_idx" ON "user_role"("user_id");

-- CreateIndex
CREATE INDEX "user_role_role_id_idx" ON "user_role"("role_id");

-- CreateIndex
CREATE INDEX "user_role_scope_type_scope_id_idx" ON "user_role"("scope_type", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_user_id_role_id_scope_type_scope_id_key" ON "user_role"("user_id", "role_id", "scope_type", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_refresh_token_hash_key" ON "session"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_revoked_at_idx" ON "session"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "session_family_id_idx" ON "session"("family_id");

-- CreateIndex
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_token_token_hash_key" ON "password_reset_token"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_token_user_id_idx" ON "password_reset_token"("user_id");

-- CreateIndex
CREATE INDEX "password_reset_token_expires_at_idx" ON "password_reset_token"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_token_token_hash_key" ON "email_verification_token"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_token_user_id_idx" ON "email_verification_token"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_factor_user_id_type_key" ON "mfa_factor"("user_id", "type");

-- CreateIndex
CREATE INDEX "team_deleted_at_idx" ON "team"("deleted_at");

-- CreateIndex
CREATE INDEX "team_member_user_id_idx" ON "team_member"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_key_hash_key" ON "api_key"("key_hash");

-- CreateIndex
CREATE INDEX "api_key_user_id_idx" ON "api_key"("user_id");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_created_at_idx" ON "audit_log"("entity_type", "entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_actor_user_id_created_at_idx" ON "audit_log"("actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_category_created_at_idx" ON "audit_log"("category", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at" DESC);

-- CreateIndex
CREATE INDEX "outbox_event_status_available_at_idx" ON "outbox_event"("status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_event_aggregate_type_aggregate_id_idx" ON "outbox_event"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "email_log_channel_status_idx" ON "email_log"("channel", "status");

-- CreateIndex
CREATE INDEX "email_log_to_address_idx" ON "email_log"("to_address");

-- CreateIndex
CREATE INDEX "email_log_created_at_idx" ON "email_log"("created_at" DESC);

-- CreateIndex
CREATE INDEX "notification_user_id_read_at_created_at_idx" ON "notification"("user_id", "read_at", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_preference_user_id_type_key" ON "notification_preference"("user_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "document_storage_key_key" ON "document"("storage_key");

-- CreateIndex
CREATE INDEX "document_checksum_sha256_idx" ON "document"("checksum_sha256");

-- CreateIndex
CREATE INDEX "document_scan_status_idx" ON "document"("scan_status");

-- CreateIndex
CREATE INDEX "document_deleted_at_idx" ON "document"("deleted_at");

-- CreateIndex
CREATE INDEX "document_link_entity_type_entity_id_idx" ON "document_link"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_link_document_id_entity_type_entity_id_purpose_key" ON "document_link"("document_id", "entity_type", "entity_id", "purpose");

-- CreateIndex
CREATE INDEX "system_setting_category_idx" ON "system_setting"("category");

-- CreateIndex
CREATE UNIQUE INDEX "system_setting_category_key_key" ON "system_setting"("category", "key");

-- CreateIndex
CREATE UNIQUE INDEX "number_sequence_key_key" ON "number_sequence"("key");

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_key_user_id_endpoint_key" ON "idempotency_key"("key", "user_id", "endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flag_key_key" ON "feature_flag"("key");

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_token" ADD CONSTRAINT "email_verification_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_factor" ADD CONSTRAINT "mfa_factor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team" ADD CONSTRAINT "team_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_link" ADD CONSTRAINT "document_link_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
