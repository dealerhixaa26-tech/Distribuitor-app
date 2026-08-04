-- ═══════════════════════════════════════════════════════════════════════════
-- 0011 — the guards migration 0010 forgot.
--
-- Found by EXECUTION, not by review. Migration 0010's triggers were written
-- against UPDATE and left DELETE wide open, so `DELETE FROM invoice` removed an
-- ISSUED document without complaint. Deleting a filed invoice is strictly worse
-- than editing one: it destroys the gapless series rather than falsifying a
-- figure in it.
--
-- The same hole existed on `tax_note` (equally a statutory document under CGST
-- s.34, with its own gapless series) and on `payment` (whose ledger effect is
-- already posted by the time it is VERIFIED, and cannot be un-posted because
-- `ledger_entry` is append-only).
--
-- Split from 0010 rather than folded into it because 0010 was already applied,
-- and a separate migration records honestly that these were missed the first
-- time. See ADR-0016 §5 and ADR-0018 §5.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 7. Issued documents cannot be DELETED either ───────────────────────────
-- Found by execution, not by review: the UPDATE triggers above were written
-- first and left DELETE wide open, so `DELETE FROM invoice` removed an ISSUED
-- document without complaint. Deleting a filed invoice is strictly worse than
-- editing one — it destroys the gapless series rather than falsifying a figure.
--
-- A DRAFT stays freely deletable: it consumed no number and has no ledger
-- effect, which is the whole reason numbering happens at issue and not before.

CREATE OR REPLACE FUNCTION issued_document_is_undeletable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION
      '% % is % and cannot be deleted. Cancel it, or correct it with a credit or debit note — a statutory series must stay gapless.',
      TG_TABLE_NAME, COALESCE(OLD."number", OLD."id"::text), OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_no_delete_once_issued
  BEFORE DELETE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION issued_document_is_undeletable();

CREATE TRIGGER tax_note_no_delete_once_issued
  BEFORE DELETE ON "tax_note"
  FOR EACH ROW EXECUTE FUNCTION issued_document_is_undeletable();

-- ── 8. An issued tax note is frozen, exactly as an invoice is ──────────────
-- ADR-0017 argues a note is structurally the same document as an invoice. The
-- immutability argument transfers with it: a note carries its own gapless
-- number and lands in GSTR-1 9B, so an edited one falsifies a filed return.

CREATE OR REPLACE FUNCTION tax_note_is_immutable_once_issued()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  IF NEW."number"                     IS DISTINCT FROM OLD."number"
  OR NEW."type"                       IS DISTINCT FROM OLD."type"
  OR NEW."original_invoice_id"        IS DISTINCT FROM OLD."original_invoice_id"
  OR NEW."note_date"                  IS DISTINCT FROM OLD."note_date"
  OR NEW."reason"                     IS DISTINCT FROM OLD."reason"
  OR NEW."place_of_supply_state_code" IS DISTINCT FROM OLD."place_of_supply_state_code"
  OR NEW."supplier_state_code"        IS DISTINCT FROM OLD."supplier_state_code"
  OR NEW."counterparty_gstin"         IS DISTINCT FROM OLD."counterparty_gstin"
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
      'Tax note % is % and is frozen. Issue a further note rather than editing this one.',
      COALESCE(OLD."number", OLD."id"::text), OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tax_note_frozen_once_issued
  BEFORE UPDATE ON "tax_note"
  FOR EACH ROW EXECUTE FUNCTION tax_note_is_immutable_once_issued();

CREATE OR REPLACE FUNCTION tax_note_line_is_immutable_once_issued()
RETURNS TRIGGER AS $$
DECLARE
  parent_status TEXT;
BEGIN
  SELECT n."status"::text INTO parent_status FROM "tax_note" n
  WHERE n."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."tax_note_id" ELSE NEW."tax_note_id" END;

  IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'This tax note is % — its lines are frozen.', parent_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tax_note_line_frozen_once_issued
  BEFORE UPDATE OR DELETE ON "tax_note_line"
  FOR EACH ROW EXECUTE FUNCTION tax_note_line_is_immutable_once_issued();

-- ── 9. A verified payment's amount is frozen ───────────────────────────────
-- Verification is the financial event (ADR-0018): the ledger has been credited
-- by the time status leaves RECORDED. Editing the amount afterwards would put
-- the ledger and the receipt into permanent disagreement, with the ledger —
-- being append-only — unable to follow.
--
-- Correcting a verified payment means BOUNCED plus a fresh receipt.

CREATE OR REPLACE FUNCTION payment_is_immutable_once_verified()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'RECORDED' THEN
    RETURN NEW;
  END IF;

  IF NEW."amount"         IS DISTINCT FROM OLD."amount"
  OR NEW."tds_amount"     IS DISTINCT FROM OLD."tds_amount"
  OR NEW."payment_date"   IS DISTINCT FROM OLD."payment_date"
  OR NEW."method"         IS DISTINCT FROM OLD."method"
  OR NEW."distributor_id" IS DISTINCT FROM OLD."distributor_id"
  OR NEW."customer_id"    IS DISTINCT FROM OLD."customer_id"
  OR NEW."number"         IS DISTINCT FROM OLD."number"
  THEN
    RAISE EXCEPTION
      'Payment % is % — its amount and party are frozen because the ledger has already been credited. Mark it BOUNCED and record a corrected receipt.',
      OLD."number", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_frozen_once_verified
  BEFORE UPDATE ON "payment"
  FOR EACH ROW EXECUTE FUNCTION payment_is_immutable_once_verified();

CREATE OR REPLACE FUNCTION payment_is_undeletable_once_verified()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" <> 'RECORDED' THEN
    RAISE EXCEPTION
      'Payment % is % and cannot be deleted — it has a ledger effect. Mark it BOUNCED or CANCELLED instead.',
      OLD."number", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_no_delete_once_verified
  BEFORE DELETE ON "payment"
  FOR EACH ROW EXECUTE FUNCTION payment_is_undeletable_once_verified();
