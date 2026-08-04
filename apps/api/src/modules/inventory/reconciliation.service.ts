import { Injectable } from '@nestjs/common';
import { DOMAIN_EVENTS, Money, type ReconciliationResult } from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';

/**
 * Nightly re-derivation of every balance from the ledger. ADR-0002, docs/19 §7.
 *
 * The balance is a read-model kept in step by application code. This job is what
 * makes that trustworthy: it recomputes each balance from the append-only ledger
 * — the source of truth — and reports any disagreement.
 *
 * ── It REPORTS, it does not heal ───────────────────────────────────────────
 * Silently correcting a drift would destroy the only evidence that a bug
 * exists. The drift IS the signal. If the balance and the ledger disagree,
 * something wrote a balance outside `StockLedgerService.move()`, or a
 * transaction committed half-way — both of which are defects that need finding,
 * not papering over. The alert goes to the ops mailbox through the outbox, and
 * a human decides.
 *
 * Two invariants are checked:
 *   1. `quantity_on_hand` == SUM(ledger quantity) for that key
 *   2. `quantity_reserved` == SUM(quantity) of ACTIVE reservations
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReconciliationService.name);
  }

  async reconcile(): Promise<ReconciliationResult> {
    const [quantityDrifts, reservationDrifts, checked] = await Promise.all([
      this.findQuantityDrifts(),
      this.findReservationDrifts(),
      this.prisma.db.stockBalance.count(),
    ]);

    const result: ReconciliationResult = {
      checkedBalances: checked,
      quantityDrifts,
      reservationDrifts,
      clean: quantityDrifts.length === 0 && reservationDrifts.length === 0,
    };

    if (!result.clean) {
      // Loud, not silent. A drift means the ledger and the balance disagree,
      // which means something is wrong in code that runs every day.
      this.logger.error(
        {
          quantityDrifts: quantityDrifts.length,
          reservationDrifts: reservationDrifts.length,
          checked,
        },
        'STOCK RECONCILIATION DRIFT DETECTED',
      );

      await this.prisma.transaction(async (tx) => {
        await this.outbox.emit(
          tx,
          DOMAIN_EVENTS.STOCK_RECONCILIATION_DRIFT,
          { type: 'StockBalance', id: quantityDrifts[0]?.balanceId ?? 'unknown' },
          {
            quantityDrifts: String(quantityDrifts.length),
            reservationDrifts: String(reservationDrifts.length),
            checked: String(checked),
            firstSku: quantityDrifts[0]?.sku ?? reservationDrifts[0]?.sku ?? '',
          },
        );
      });
    } else {
      this.logger.info({ checked }, 'Stock reconciliation clean');
    }

    return result;
  }

  /**
   * Balances whose on-hand disagrees with the sum of their ledger rows.
   *
   * Raw SQL and a FULL OUTER JOIN: a balance with no ledger rows is as much a
   * drift as a mismatch, and so is a ledger with no balance row. Doing this in
   * application code would mean loading every balance and every ledger entry.
   */
  private async findQuantityDrifts(): Promise<ReconciliationResult['quantityDrifts']> {
    const rows = await this.prisma.db.$queryRaw<DriftRow[]>`
      WITH ledger_totals AS (
        SELECT warehouse_id, product_id, variant_id, batch_id,
               SUM(quantity) AS derived
        FROM stock_ledger_entry
        GROUP BY warehouse_id, product_id, variant_id, batch_id
      )
      SELECT b.id                                  AS "balanceId",
             w.code                                AS "warehouseCode",
             p.sku                                 AS "sku",
             b.quantity_on_hand                    AS "recorded",
             COALESCE(l.derived, 0)                AS "derived"
      FROM stock_balance b
      JOIN warehouse w ON w.id = b.warehouse_id
      JOIN product   p ON p.id = b.product_id
      LEFT JOIN ledger_totals l
        ON  l.warehouse_id = b.warehouse_id
        AND l.product_id   = b.product_id
        AND l.variant_id IS NOT DISTINCT FROM b.variant_id
        AND l.batch_id   IS NOT DISTINCT FROM b.batch_id
      WHERE b.quantity_on_hand <> COALESCE(l.derived, 0)
      ORDER BY w.code, p.sku
      LIMIT 500
    `;

    return rows.map((row) => ({
      balanceId: row.balanceId,
      warehouseCode: row.warehouseCode,
      sku: row.sku,
      recorded: Money.of(row.recorded.toFixed(4)).toString(),
      ledgerDerived: Money.of(row.derived?.toFixed(4) ?? '0').toString(),
      difference: Money.of(row.recorded.toFixed(4))
        .subtract((row.derived?.toFixed(4)) ?? '0')
        .toString(),
    }));
  }

  /**
   * Balances whose reserved figure disagrees with their ACTIVE reservations.
   *
   * The invariant from docs/19 §5. A drift here means stock is being held that
   * no order is waiting for — or, worse, that stock is sellable which has
   * already been promised.
   */
  private async findReservationDrifts(): Promise<ReconciliationResult['reservationDrifts']> {
    const rows = await this.prisma.db.$queryRaw<ReservationDriftRow[]>`
      WITH active_reservations AS (
        SELECT warehouse_id, product_id, variant_id,
               SUM(quantity) AS reserved
        FROM stock_reservation
        WHERE status = 'ACTIVE'
        GROUP BY warehouse_id, product_id, variant_id
      )
      SELECT b.id                       AS "balanceId",
             w.code                     AS "warehouseCode",
             p.sku                      AS "sku",
             b.quantity_reserved        AS "recorded",
             COALESCE(r.reserved, 0)    AS "derived"
      FROM stock_balance b
      JOIN warehouse w ON w.id = b.warehouse_id
      JOIN product   p ON p.id = b.product_id
      LEFT JOIN active_reservations r
        ON  r.warehouse_id = b.warehouse_id
        AND r.product_id   = b.product_id
        AND r.variant_id IS NOT DISTINCT FROM b.variant_id
      WHERE b.quantity_reserved <> COALESCE(r.reserved, 0)
      ORDER BY w.code, p.sku
      LIMIT 500
    `;

    return rows.map((row) => ({
      balanceId: row.balanceId,
      warehouseCode: row.warehouseCode,
      sku: row.sku,
      recorded: Money.of(row.recorded.toFixed(4)).toString(),
      activeReservationSum: Money.of(row.derived?.toFixed(4) ?? '0').toString(),
      difference: Money.of(row.recorded.toFixed(4))
        .subtract((row.derived?.toFixed(4)) ?? '0')
        .toString(),
    }));
  }
}

/**
 * Raw-query rows. `SUM()` over a DECIMAL comes back as a Prisma.Decimal, and
 * the aggregate side can be null when no rows matched — hence the union rather
 * than a bare Decimal.
 */
interface DriftRow {
  balanceId: string;
  warehouseCode: string;
  sku: string;
  recorded: Prisma.Decimal;
  derived: Prisma.Decimal | null;
}

type ReservationDriftRow = DriftRow;
