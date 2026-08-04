import { Injectable } from '@nestjs/common';
import { Money, signForMovement, type StockMovementType } from '@hixaa/contracts';
import { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import { ConflictError, InsufficientStockError } from '../../common/errors/domain.error';
import type { PrismaTransaction } from '../../infrastructure/database/prisma.service';
import { ledgerUnitCost, nextAverageCost } from './costing';

/**
 * The stock ledger core. See ADR-0002 and docs/19 §3.
 *
 * ── The one thing this file exists to get right ────────────────────────────
 * Two users dispatch the last unit at the same instant. Exactly ONE succeeds.
 *
 * That is not achieved by careful application logic — it is achieved by taking
 * a row lock BEFORE reading the quantity, so the two transactions serialise.
 * The classic bug is to check availability and *then* lock: it reads correctly,
 * reviews correctly, and oversells under load. Here the lock comes first, every
 * time, with no branch that can skip it.
 *
 * ── The contract ───────────────────────────────────────────────────────────
 * `move()` is the ONLY method in the system that writes `stock_ledger_entry` or
 * `stock_balance`. Receipts, issues, adjustments, transfers, count variances,
 * and reservation consumption all funnel through it. A second write path would
 * be a second place for the lock to be forgotten, and the failure would be
 * silent — which is exactly the failure mode ADR-0002 was written to avoid.
 *
 * Every method takes an existing transaction rather than opening its own, so a
 * caller can move several products atomically: a transfer that moves three
 * lines must move all three or none.
 */
@Injectable()
export class StockLedgerService {
  constructor(
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(StockLedgerService.name);
  }

  /**
   * Posts one movement: append to the ledger, update the derived balance.
   *
   * `quantity` is always POSITIVE. The sign is applied here from the movement
   * type, so no caller can post a "receipt" of −5 and quietly reduce stock.
   * `ADJUSTMENT` is the exception and takes a signed quantity, because being
   * able to go either way is the entire purpose of an adjustment.
   */
  async move(
    tx: PrismaTransaction,
    input: {
      warehouseId: string;
      productId: string;
      variantId?: string | null;
      batchId?: string | null;
      movementType: StockMovementType;
      /** Positive, except for ADJUSTMENT which is signed. */
      quantity: string;
      unitCost?: string | null;
      refType?: string | null;
      refId?: string | null;
      reason?: string | null;
      occurredAt?: Date;
      actorId?: string | null;
    },
  ): Promise<{ balanceId: string; quantityOnHand: string; averageCost: string }> {
    const signed = this.signedQuantity(input.movementType, input.quantity);
    if (signed.isZero()) {
      throw new ConflictError('A stock movement of zero is not a movement.');
    }

    // ── 1. LOCK FIRST ────────────────────────────────────────────────────
    const balance = await this.lockBalance(tx, input);

    const onHandBefore = Money.of(balance.quantityOnHand);
    const reserved = Money.of(balance.quantityReserved);
    const onHandAfter = onHandBefore.add(signed);

    // ── 2. Check under the lock ──────────────────────────────────────────
    if (onHandAfter.isNegative()) {
      throw new InsufficientStockError(
        balance.warehouseCode,
        onHandBefore.toDisplayString(),
        signed.abs().toDisplayString(),
      );
    }

    // Reserved stock is physically present but committed. Issuing below the
    // reserved level would leave promises the warehouse cannot keep, and the
    // CHECK constraint would reject the row anyway — better a clear 409 than a
    // raw constraint violation.
    if (onHandAfter.lt(reserved)) {
      throw new ConflictError(
        `Cannot reduce stock to ${onHandAfter.toDisplayString()} — ` +
          `${reserved.toDisplayString()} is reserved against approved orders. ` +
          'Release a reservation first.',
      );
    }

    // ── 3. Cost, on inbound only (ADR-0010) ──────────────────────────────
    const currentAverage = Money.of(balance.averageCost);
    const averageCost = nextAverageCost({
      onHandBefore,
      currentAverage,
      movementQuantity: signed,
      movementUnitCost: input.unitCost ?? null,
    });

    // The cost this movement is RECORDED at, which is not the new average: a
    // receipt records what was paid, an issue records the average prevailing
    // before it. That is what makes the ledger a faithful COGS record.
    const recordedUnitCost = ledgerUnitCost({
      inbound: signed.isPositive(),
      currentAverage,
      movementUnitCost: input.unitCost ?? null,
    });

    const occurredAt = input.occurredAt ?? this.clock.now();

    // ── 4. Append to the ledger ──────────────────────────────────────────
    await tx.stockLedgerEntry.create({
      data: {
        warehouseId: input.warehouseId,
        productId: input.productId,
        variantId: input.variantId ?? null,
        batchId: input.batchId ?? null,
        movementType: input.movementType,
        quantity: signed.toString(),
        unitCost: recordedUnitCost.toString(),
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        reason: input.reason ?? null,
        occurredAt,
        createdById: input.actorId ?? null,
      },
      select: { id: true },
    });

    // ── 5. Update the derived balance ────────────────────────────────────
    // `quantityAvailable` is deliberately absent: a database trigger derives it
    // (migration 0007). Writing it here would be the bug that trigger prevents.
    await tx.stockBalance.update({
      where: { id: balance.id },
      data: {
        quantityOnHand: onHandAfter.toString(),
        averageCost: averageCost.toString(),
        lastMovementAt: occurredAt,
      },
    });

    return {
      balanceId: balance.id,
      quantityOnHand: onHandAfter.toString(),
      averageCost: averageCost.toString(),
    };
  }

  /**
   * Adjusts only the reserved figure, leaving on-hand untouched.
   *
   * Reserving does not move stock — the goods are still on the shelf — so this
   * writes no ledger row. The ledger records physical movement; a reservation
   * is a promise. Conflating the two would make the ledger's sum stop matching
   * on-hand, which is the exact drift the reconciliation job looks for.
   */
  async adjustReserved(
    tx: PrismaTransaction,
    input: {
      warehouseId: string;
      productId: string;
      variantId?: string | null;
      /** Positive to reserve, negative to release or consume. */
      delta: string;
    },
  ): Promise<{ balanceId: string; quantityReserved: string }> {
    const balance = await this.lockBalance(tx, input);

    const onHand = Money.of(balance.quantityOnHand);
    const reservedAfter = Money.of(balance.quantityReserved).add(input.delta);

    if (reservedAfter.isNegative()) {
      throw new ConflictError(
        `Cannot release ${Money.of(input.delta).abs().toDisplayString()} — only ` +
          `${Money.of(balance.quantityReserved).toDisplayString()} is reserved.`,
      );
    }

    // You cannot promise more than you hold. This is the check that stops an
    // order being approved against stock that is already spoken for.
    if (reservedAfter.gt(onHand)) {
      const available = onHand.subtract(balance.quantityReserved);
      throw new InsufficientStockError(
        balance.warehouseCode,
        available.toDisplayString(),
        Money.of(input.delta).toDisplayString(),
      );
    }

    await tx.stockBalance.update({
      where: { id: balance.id },
      data: { quantityReserved: reservedAfter.toString() },
    });

    return { balanceId: balance.id, quantityReserved: reservedAfter.toString() };
  }

  /**
   * Reserves AS MUCH as is available, up to `requested`, and reports both.
   *
   * Exists for ADR-0012: approval reserves what exists and backorders the rest.
   * The decision of "how much is available" is made HERE, under the same row
   * lock as the write — computing it in the caller and then reserving would be
   * a read-then-write race, and two orders approving simultaneously could each
   * believe the same units were free.
   *
   * Returns zero reserved rather than throwing when nothing is available: for a
   * build-to-order business that is a normal outcome, not an error.
   */
  async reserveUpTo(
    tx: PrismaTransaction,
    input: {
      warehouseId: string;
      productId: string;
      variantId?: string | null;
      requested: string;
    },
  ): Promise<{ reserved: string; backordered: string }> {
    const balance = await this.lockBalance(tx, input);

    const requested = Money.of(input.requested);
    const onHand = Money.of(balance.quantityOnHand);
    const alreadyReserved = Money.of(balance.quantityReserved);
    const available = Money.max(onHand.subtract(alreadyReserved), Money.zero());

    const toReserve = Money.min(requested, available);

    if (toReserve.isPositive()) {
      await tx.stockBalance.update({
        where: { id: balance.id },
        data: { quantityReserved: alreadyReserved.add(toReserve).toString() },
      });
    }

    return {
      reserved: toReserve.toString(),
      backordered: requested.subtract(toReserve).toString(),
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Finds or creates the balance row, and locks it FOR UPDATE.
   *
   * `SELECT ... FOR UPDATE` is raw SQL because Prisma has no lock clause. That
   * is the whole reason this method exists — and the reason nothing else in the
   * codebase is allowed to read a balance for the purpose of changing it.
   *
   * The insert-then-lock dance handles the first movement for a
   * (warehouse, product): `ON CONFLICT DO NOTHING` makes two concurrent first
   * movements safe — one inserts, the other no-ops, and both then lock the same
   * row rather than creating a duplicate.
   */
  private async lockBalance(
    tx: PrismaTransaction,
    key: {
      warehouseId: string;
      productId: string;
      variantId?: string | null;
      batchId?: string | null;
    },
  ): Promise<LockedBalance> {
    const variantId = key.variantId ?? null;
    const batchId = key.batchId ?? null;

    // `IS NOT DISTINCT FROM` rather than `=` so a NULL variant/batch matches a
    // NULL, which `=` never does. Getting this wrong would silently create a
    // second balance row per movement.
    const rows = await tx.$queryRaw<LockedBalanceRow[]>`
      SELECT b.id,
             b.quantity_on_hand   AS "quantityOnHand",
             b.quantity_reserved  AS "quantityReserved",
             b.average_cost       AS "averageCost",
             w.code               AS "warehouseCode"
      FROM stock_balance b
      JOIN warehouse w ON w.id = b.warehouse_id
      WHERE b.warehouse_id = ${key.warehouseId}::uuid
        AND b.product_id   = ${key.productId}::uuid
        AND b.variant_id IS NOT DISTINCT FROM ${variantId}::uuid
        AND b.batch_id   IS NOT DISTINCT FROM ${batchId}::uuid
      FOR UPDATE OF b
    `;

    const existing = rows[0];
    if (existing) return this.toLocked(existing);

    // No balance yet — the common case at launch, since the ledger starts empty.
    await tx.$executeRaw`
      INSERT INTO stock_balance
        (id, warehouse_id, product_id, variant_id, batch_id,
         quantity_on_hand, quantity_reserved, average_cost, created_at, updated_at)
      VALUES
        (gen_random_uuid(), ${key.warehouseId}::uuid, ${key.productId}::uuid,
         ${variantId}::uuid, ${batchId}::uuid, 0, 0, 0, now(), now())
      ON CONFLICT DO NOTHING
    `;

    const created = await tx.$queryRaw<LockedBalanceRow[]>`
      SELECT b.id,
             b.quantity_on_hand   AS "quantityOnHand",
             b.quantity_reserved  AS "quantityReserved",
             b.average_cost       AS "averageCost",
             w.code               AS "warehouseCode"
      FROM stock_balance b
      JOIN warehouse w ON w.id = b.warehouse_id
      WHERE b.warehouse_id = ${key.warehouseId}::uuid
        AND b.product_id   = ${key.productId}::uuid
        AND b.variant_id IS NOT DISTINCT FROM ${variantId}::uuid
        AND b.batch_id   IS NOT DISTINCT FROM ${batchId}::uuid
      FOR UPDATE OF b
    `;

    const row = created[0];
    if (!row) {
      // Would mean the warehouse or product vanished mid-transaction.
      throw new ConflictError(
        'Could not establish a stock balance row — the warehouse or product may have been removed.',
      );
    }
    return this.toLocked(row);
  }

  private toLocked(row: LockedBalanceRow): LockedBalance {
    return {
      id: row.id,
      warehouseCode: row.warehouseCode,
      quantityOnHand: row.quantityOnHand.toFixed(4),
      quantityReserved: row.quantityReserved.toFixed(4),
      averageCost: row.averageCost.toFixed(4),
    };
  }

  /** Applies the sign the movement type dictates. See `signForMovement`. */
  private signedQuantity(type: StockMovementType, quantity: string): Money {
    const sign = signForMovement(type);
    const magnitude = Money.of(quantity);

    // ADJUSTMENT (sign 0) is the only type that carries its own sign.
    if (sign === 0) return magnitude;

    if (magnitude.isNegative()) {
      throw new ConflictError(
        `A ${type} takes a positive quantity — its direction is fixed by the movement type.`,
      );
    }
    return sign === 1 ? magnitude : magnitude.negate();
  }

}

interface LockedBalanceRow {
  id: string;
  quantityOnHand: Prisma.Decimal;
  quantityReserved: Prisma.Decimal;
  averageCost: Prisma.Decimal;
  warehouseCode: string;
}

interface LockedBalance {
  id: string;
  warehouseCode: string;
  quantityOnHand: string;
  quantityReserved: string;
  averageCost: string;
}
