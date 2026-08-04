-- ═════════════════════════════════════════════════════════════════════════════
-- 0009 — Let a reservation be drawn DOWN to zero as goods ship.
--
-- Migration 0007 asserted `quantity > 0` on every reservation. That was correct
-- for Phase 6, where a reservation was created and consumed WHOLE. Phase 7
-- introduced partial dispatch (ADR-0012 §3): a line reserved for 10 may go out
-- as 4 now and 6 later, and `quantity` — which means "how much is STILL held" —
-- reaches zero on the final draw.
--
-- The old constraint therefore rejected the last shipment of every order, with
-- stock already issued inside the same transaction. Found by dispatching a real
-- shipment; it typechecked and passed every unit test.
--
-- The replacement is STRICTER where it matters rather than merely looser: an
-- ACTIVE reservation must still hold something (a live hold of zero is
-- meaningless and would make `quantity_reserved` drift), while a closed one may
-- legitimately hold nothing because it has been fully drawn.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "stock_reservation" DROP CONSTRAINT "stock_reservation_quantity_positive";

ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_quantity_valid"
  CHECK (
    ("status" = 'ACTIVE' AND "quantity" > 0)
    OR ("status" <> 'ACTIVE' AND "quantity" >= 0)
  );
