import { Injectable } from '@nestjs/common';
import { financialYearOf } from '@hixaa/contracts';
import { ClockService } from '../../common/utils/clock.service';
import { InternalError } from '../../common/errors/domain.error';
import type { PrismaTransaction } from '../../infrastructure/database/prisma.service';

/**
 * Gapless business-number allocation.
 *
 * ── Why this is not `MAX(id) + 1` or a Postgres sequence ───────────────────
 * Under Indian GST, gaps in an invoice series invite scrutiny. A Postgres
 * `SEQUENCE` deliberately does NOT roll back on abort — that is what makes it
 * fast and concurrent — so a failed transaction burns a number permanently.
 *
 * This allocates inside the caller's transaction with `SELECT … FOR UPDATE`.
 * Concurrent allocations serialise on the row lock, and a rolled-back
 * transaction returns the number. The cost is that number allocation is a
 * serialisation point; for documents issued at human speed, that is the right
 * trade.
 *
 * Used for distributor and customer codes now, and for the statutory invoice
 * series in Phase 8 — the same mechanism, which is why it is built once here.
 */
@Injectable()
export class NumberSequenceService {
  constructor(private readonly clock: ClockService) {}

  /**
   * Allocates the next number for a key.
   *
   * MUST be called with a transaction client. Allocating outside the caller's
   * transaction reintroduces exactly the gap problem this exists to prevent.
   */
  async next(tx: PrismaTransaction, key: string): Promise<string> {
    /*
     * Two shapes exist, and the caller should not have to know which:
     *   • NEVER-resetting series use the plain key   — `DISTRIBUTOR`
     *   • YEARLY series are per financial year       — `INVOICE:2026-27`
     *
     * Resolved by trying the exact key first and falling back to the
     * financial-year form. Inferring from the key's format (as a first pass
     * did) is wrong: it assumes the caller already knows the reset policy,
     * and gets it silently wrong when they do not.
     */
    const candidates = key.includes(':') ? [key] : [key, this.withFinancialYear(key)];

    // FOR UPDATE: the lock is held until the caller's transaction commits, so
    // two concurrent allocations cannot read the same next_value.
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        key: string;
        prefix: string;
        separator: string;
        next_value: number;
        padding: number;
      }>
    >`
      SELECT id, key, prefix, separator, next_value, padding
      FROM number_sequence
      WHERE key = ANY(${candidates}::text[])
      ORDER BY array_position(${candidates}::text[], key)
      LIMIT 1
      FOR UPDATE
    `;

    const sequence = rows[0];
    if (!sequence) {
      throw new InternalError(
        `No number sequence configured for "${key}" (tried: ${candidates.join(', ')})`,
        { key, candidates },
      );
    }

    await tx.numberSequence.update({
      where: { id: sequence.id },
      data: { nextValue: sequence.next_value + 1 },
    });

    const padded = String(sequence.next_value).padStart(sequence.padding, '0');
    /*
     * The separator is per-sequence, not a hardcoded hyphen.
     *
     * It WAS hardcoded, which meant the invoice series produced
     * `HTPL/INV/2026-27-00001` while both `docs/HANDOFF.md` §7 and
     * `docs/12-recommendations.md` §E documented `HTPL/INV/2026-27/00001`. It
     * went unnoticed because every series exercised before Phase 8 —
     * `DIST-`, `CUST-`, `SO/`, `QT/`, `DC/`, `TRF-` — looks unremarkable with a
     * hyphen. Caught while answering E2, before the first invoice existed.
     */
    return `${sequence.prefix}${sequence.separator}${padded}`;
  }

  /** `INVOICE` → `INVOICE:2026-27` for series that reset each financial year. */
  private withFinancialYear(key: string): string {
    return `${key}:${financialYearOf(this.clock.now())}`;
  }
}
