-- ═════════════════════════════════════════════════════════════════════════════
-- 0003 — timestamp → timestamptz
--
-- docs/02-data-model.md §0 states every timestamp is TIMESTAMPTZ stored in UTC.
-- It was not: Prisma's `DateTime` maps to a naive `timestamp(3)` unless given an
-- explicit `@db.Timestamptz`, so 60 columns were created without a timezone.
--
-- Why that is a real defect, not a cosmetic one:
--   • A naive column has no timezone, so Postgres interprets it in the SESSION
--     timezone. Any tool connecting with a non-UTC session (psql, a restore, a
--     DBA) writes wall-clock time and silently corrupts ordering.
--   • The outbox dispatcher compares `available_at <= now()` in raw SQL. With a
--     naive column and an Asia/Kolkata session, that compared a UTC value
--     against an IST clock — retries fired 5h30m early.
--
-- ⚠ The SET LOCAL below is load-bearing. A bare `SET DATA TYPE TIMESTAMPTZ`
--   interprets existing naive values in the session timezone. Our values were
--   written by Node as UTC instants, so converting under Asia/Kolkata would
--   shift every historical timestamp by −5h30m. Forcing the session to UTC
--   makes the implicit conversion read them as what they actually are.
-- ═════════════════════════════════════════════════════════════════════════════
SET LOCAL TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "api_key" ALTER COLUMN "last_used_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "audit_log" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "document" ALTER COLUMN "scanned_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "document_link" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "email_log" ALTER COLUMN "sent_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "email_verification_token" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "used_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "feature_flag" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "idempotency_key" ALTER COLUMN "locked_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "mfa_factor" ALTER COLUMN "confirmed_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "last_used_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "notification" ALTER COLUMN "read_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "notification_preference" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "number_sequence" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "outbox_event" ALTER COLUMN "available_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "processed_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "password_reset_token" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "used_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "permission" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "role" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "role_permission" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "session" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "last_used_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "system_setting" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "team" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "team_member" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "user" ALTER COLUMN "email_verified_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "locked_until" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "password_changed_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "last_login_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "user_role" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);
