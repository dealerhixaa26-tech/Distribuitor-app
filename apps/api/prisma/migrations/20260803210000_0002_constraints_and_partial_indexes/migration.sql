-- ═════════════════════════════════════════════════════════════════════════════
-- 0002 — Database-level guarantees Prisma's schema language cannot express.
--
-- These are not optimisations layered on later; they are correctness controls
-- that must hold even if application logic is bypassed or buggy.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Extensions ──────────────────────────────────────────────────────────────
-- pg_trgm powers typo-tolerant search ("raksah" → "Raksha") in Phase 4.
-- unaccent makes matching diacritic-insensitive.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;


-- ── Audit log: append-only, enforced by the database ────────────────────────
-- docs/06-security.md §8 states the audit log is append-only. A convention that
-- lives only in code is a convention that a future migration script, an ORM
-- escape hatch, or a psql session can quietly break. This makes it structural.
CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log is append-only: % is not permitted. Corrections are new rows.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();


-- ── Outbox dispatcher poll ──────────────────────────────────────────────────
-- The dispatcher runs this query roughly once a second, forever. A partial
-- index covers only rows still awaiting delivery, so the index stays small
-- permanently no matter how large the processed history grows.
CREATE INDEX "outbox_event_pending_idx"
  ON "outbox_event" ("available_at", "id")
  WHERE "status" IN ('PENDING', 'FAILED');

-- Retry/DLQ triage.
CREATE INDEX "outbox_event_dead_idx"
  ON "outbox_event" ("created_at" DESC)
  WHERE "status" = 'DEAD';


-- ── Session lookups ─────────────────────────────────────────────────────────
-- Only live sessions are ever queried by user; revoked rows are history.
CREATE INDEX "session_active_idx"
  ON "session" ("user_id", "expires_at")
  WHERE "revoked_at" IS NULL;


-- ── Single-use token lookups ────────────────────────────────────────────────
CREATE INDEX "password_reset_token_unused_idx"
  ON "password_reset_token" ("expires_at")
  WHERE "used_at" IS NULL;

CREATE INDEX "email_verification_token_unused_idx"
  ON "email_verification_token" ("expires_at")
  WHERE "used_at" IS NULL;


-- ── Documents pending virus scan ────────────────────────────────────────────
-- A document is undownloadable until a scanner clears it; this drives the
-- scanner's work queue.
CREATE INDEX "document_scan_pending_idx"
  ON "document" ("created_at")
  WHERE "scan_status" = 'PENDING';


-- ── Value constraints ───────────────────────────────────────────────────────
-- Defence in depth: the service layer validates these, and so does the database.

ALTER TABLE "user"
  ADD CONSTRAINT "user_failed_attempts_non_negative"
  CHECK ("failed_login_attempts" >= 0);

ALTER TABLE "role"
  ADD CONSTRAINT "role_max_discount_percent_range"
  CHECK ("max_discount_percent" IS NULL
         OR ("max_discount_percent" >= 0 AND "max_discount_percent" <= 100));

ALTER TABLE "role"
  ADD CONSTRAINT "role_max_order_value_non_negative"
  CHECK ("max_order_value" IS NULL OR "max_order_value" >= 0);

ALTER TABLE "outbox_event"
  ADD CONSTRAINT "outbox_event_attempts_non_negative"
  CHECK ("attempts" >= 0);

ALTER TABLE "number_sequence"
  ADD CONSTRAINT "number_sequence_next_value_positive"
  CHECK ("next_value" >= 1);

ALTER TABLE "number_sequence"
  ADD CONSTRAINT "number_sequence_padding_sane"
  CHECK ("padding" BETWEEN 1 AND 12);

ALTER TABLE "document"
  ADD CONSTRAINT "document_size_positive"
  CHECK ("size_bytes" > 0);

-- A scoped role assignment must carry a scope id; a global one must not.
-- Without this, a mis-set scope_type silently widens a user's data boundary,
-- which is the exact failure ADR-0003 exists to prevent.
ALTER TABLE "user_role"
  ADD CONSTRAINT "user_role_scope_id_matches_scope_type"
  CHECK (
    ("scope_type" = 'GLOBAL' AND "scope_id" IS NULL)
    OR ("scope_type" <> 'GLOBAL' AND "scope_id" IS NOT NULL)
  );


-- ── Case-insensitive email uniqueness ───────────────────────────────────────
-- Emails are stored lowercase by emailSchema in @hixaa/contracts. This index is
-- the backstop that makes the invariant true regardless of the write path.
CREATE UNIQUE INDEX "user_email_lower_key" ON "user" (LOWER("email"));
