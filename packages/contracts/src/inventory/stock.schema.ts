import { z } from 'zod';
import {
  businessCodeSchema,
  dateOnlySchema,
  dateTimeSchema,
  idSchema,
  mediumTextSchema,
  shortTextSchema,
} from '../primitives/common';
import { positiveMoneySchema, quantitySchema } from '../primitives/money';
import { cursorPaginationSchema } from '../primitives/pagination';
import {
  reservationStatusSchema,
  serialStatusSchema,
  stockMovementTypeSchema,
  transferStatusSchema,
} from '../enums';

/**
 * Stock movement contracts. See ADR-0002 and docs/19.
 *
 * Quantities are `quantitySchema` — a positive decimal STRING, for the same
 * reason money is (ADR-0004). A quantity multiplied by a unit cost becomes a
 * monetary value, and starting that chain from an IEEE-754 double reintroduces
 * the drift the whole design exists to prevent.
 *
 * Note that every request below takes a POSITIVE quantity. The SIGN is applied
 * by the service from the movement type, so a caller cannot post a "receipt" of
 * −5 and quietly reduce stock. The database enforces the same rule
 * (`stock_ledger_sign_matches_type`).
 */

// ── Receipts, issues, adjustments ───────────────────────────────────────────

export const stockLineSchema = z.object({
  productId: idSchema,
  variantId: idSchema.optional(),
  batchId: idSchema.optional(),
  quantity: quantitySchema,
});

export const goodsReceiptSchema = z.object({
  warehouseId: idSchema,
  lines: z
    .array(
      stockLineSchema.extend({
        /** GST-exclusive landed cost per unit. Drives the weighted average
         *  (ADR-0010). Omitted means "keep the current average". */
        unitCost: positiveMoneySchema.optional(),
      }),
    )
    .min(1)
    .max(500),
  /** When the goods physically arrived — a backdated receipt is a real thing. */
  occurredAt: dateTimeSchema.optional(),
  refType: shortTextSchema.optional(),
  refId: idSchema.optional(),
  notes: mediumTextSchema.optional(),
});
export type GoodsReceiptDto = z.infer<typeof goodsReceiptSchema>;

export const stockIssueSchema = z.object({
  warehouseId: idSchema,
  lines: z
    .array(
      stockLineSchema.extend({
        /**
         * One per unit, mandatory for a serialized product (ADR-0009).
         * The service refuses when the count does not equal the quantity —
         * a partial serial list would leave units untraceable.
         */
        serials: z.array(shortTextSchema).max(1000).optional(),
      }),
    )
    .min(1)
    .max(500),
  /** Set when issuing against a distributor shipment; drives serial ownership. */
  distributorId: idSchema.optional(),
  occurredAt: dateTimeSchema.optional(),
  refType: shortTextSchema.optional(),
  refId: idSchema.optional(),
  notes: mediumTextSchema.optional(),
});
export type StockIssueDto = z.infer<typeof stockIssueSchema>;

/** Reason codes, declared as data so the list is inspectable and testable. */
export const ADJUSTMENT_REASONS = [
  'STOCK_COUNT_VARIANCE',
  'DAMAGED',
  'LOST',
  'FOUND',
  'EXPIRED',
  'SAMPLE_ISSUED',
  'RETURN_TO_VENDOR',
  'DATA_CORRECTION',
  'OTHER',
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];
export const adjustmentReasonSchema = z.enum(ADJUSTMENT_REASONS);

export const stockAdjustmentSchema = z.object({
  warehouseId: idSchema,
  productId: idSchema,
  variantId: idSchema.optional(),
  batchId: idSchema.optional(),
  /**
   * SIGNED here, uniquely — an adjustment is the one movement that can go
   * either way, and forcing the caller to say which is the point.
   */
  quantity: z
    .string()
    .regex(/^-?\d{1,15}(\.\d{1,4})?$/, 'A signed decimal quantity, e.g. "-3" or "12.5"')
    .refine((v) => Number(v) !== 0, 'An adjustment of zero is not a change'),
  reasonCode: adjustmentReasonSchema,
  /** Free text beyond the code. An unexplained stock change reads as theft. */
  reason: z.string().trim().min(5, 'Explain the adjustment').max(500),
  occurredAt: dateTimeSchema.optional(),
});
export type StockAdjustmentDto = z.infer<typeof stockAdjustmentSchema>;

export const openingBalanceSchema = z.object({
  warehouseId: idSchema,
  lines: z
    .array(stockLineSchema.extend({ unitCost: positiveMoneySchema.optional() }))
    .min(1)
    .max(1000),
  /** The stock-take date these figures were true on. */
  occurredAt: dateTimeSchema.optional(),
  notes: mediumTextSchema.optional(),
});
export type OpeningBalanceDto = z.infer<typeof openingBalanceSchema>;

// ── Transfers ───────────────────────────────────────────────────────────────

export const createTransferSchema = z
  .object({
    sourceWarehouseId: idSchema,
    destinationWarehouseId: idSchema,
    transitWarehouseId: idSchema.optional(),
    lines: z.array(stockLineSchema).min(1).max(500),
    notes: mediumTextSchema.optional(),
  })
  .refine((v) => v.sourceWarehouseId !== v.destinationWarehouseId, {
    path: ['destinationWarehouseId'],
    message: 'A transfer must move stock between two different warehouses',
  });
export type CreateTransferDto = z.infer<typeof createTransferSchema>;

export const receiveTransferSchema = z.object({
  lines: z
    .array(
      z.object({
        productId: idSchema,
        variantId: idSchema.optional(),
        /** Short receipts are normal — damage, miscount. Recorded, not hidden. */
        quantityReceived: quantitySchema,
        notes: mediumTextSchema.optional(),
      }),
    )
    .min(1),
});

// ── Reservations ────────────────────────────────────────────────────────────

export const createReservationSchema = z.object({
  warehouseId: idSchema,
  productId: idSchema,
  variantId: idSchema.optional(),
  quantity: quantitySchema,
  orderId: idSchema.optional(),
  /** Stale reservations are swept so stock is not locked behind a dead order. */
  expiresAt: dateTimeSchema.optional(),
  notes: mediumTextSchema.optional(),
});
export type CreateReservationDto = z.infer<typeof createReservationSchema>;

export const listReservationsQuerySchema = cursorPaginationSchema.extend({
  warehouseId: idSchema.optional(),
  productId: idSchema.optional(),
  orderId: idSchema.optional(),
  status: reservationStatusSchema.optional(),
});

// ── Serials ─────────────────────────────────────────────────────────────────

export const listSerialsQuerySchema = cursorPaginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  productId: idSchema.optional(),
  distributorId: idSchema.optional(),
  status: serialStatusSchema.optional(),
  /** Warranty expiring within N days — the proactive support query. */
  warrantyExpiringInDays: z.coerce.number().int().min(1).max(3650).optional(),
});

// ── Reorder policy ──────────────────────────────────────────────────────────

export const upsertInventorySettingSchema = z
  .object({
    productId: idSchema,
    warehouseId: idSchema,
    reorderLevel: quantitySchema.or(z.literal('0')),
    reorderQuantity: quantitySchema.or(z.literal('0')),
    maxLevel: quantitySchema.optional(),
    alertEnabled: z.boolean().default(true),
  })
  .refine((v) => !v.maxLevel || Number(v.maxLevel) >= Number(v.reorderLevel), {
    path: ['maxLevel'],
    message: 'The maximum level cannot be below the reorder level',
  });
export type UpsertInventorySettingDto = z.infer<typeof upsertInventorySettingSchema>;

// ── Queries ─────────────────────────────────────────────────────────────────

export const listBalancesQuerySchema = cursorPaginationSchema.extend({
  warehouseId: idSchema.optional(),
  productId: idSchema.optional(),
  /** Only rows at or below their reorder level. */
  belowReorderLevel: z.coerce.boolean().default(false),
  /** Hide rows that hold nothing — the usual case when browsing stock. */
  inStockOnly: z.coerce.boolean().default(false),
});
export type ListBalancesQuery = z.infer<typeof listBalancesQuerySchema>;

export const listLedgerQuerySchema = cursorPaginationSchema.extend({
  warehouseId: idSchema.optional(),
  productId: idSchema.optional(),
  movementType: stockMovementTypeSchema.optional(),
  refType: shortTextSchema.optional(),
  refId: idSchema.optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});
export type ListLedgerQuery = z.infer<typeof listLedgerQuerySchema>;

// ── Response shapes ─────────────────────────────────────────────────────────

export const stockBalanceSummarySchema = z.object({
  id: idSchema,
  warehouseId: idSchema,
  warehouseCode: z.string(),
  warehouseName: z.string(),
  productId: idSchema,
  sku: z.string(),
  productName: z.string(),
  variantId: idSchema.nullable(),
  batchId: idSchema.nullable(),
  quantityOnHand: z.string(),
  quantityReserved: z.string(),
  quantityAvailable: z.string(),
  averageCost: z.string(),
  /** quantityOnHand × averageCost — what this row is worth. */
  stockValue: z.string(),
  reorderLevel: z.string().nullable(),
  isBelowReorderLevel: z.boolean(),
  lastMovementAt: dateTimeSchema.nullable(),
});
export type StockBalanceSummary = z.infer<typeof stockBalanceSummarySchema>;

export const stockLedgerEntrySummarySchema = z.object({
  id: idSchema,
  warehouseId: idSchema,
  warehouseCode: z.string(),
  productId: idSchema,
  sku: z.string(),
  productName: z.string(),
  movementType: stockMovementTypeSchema,
  quantity: z.string(),
  unitCost: z.string(),
  refType: z.string().nullable(),
  refId: idSchema.nullable(),
  reason: z.string().nullable(),
  occurredAt: dateTimeSchema,
  createdById: idSchema.nullable(),
});

/** What a serial lookup answers: where did this unit go, and is it in warranty? */
export const serialTraceSchema = z.object({
  id: idSchema,
  serial: z.string(),
  status: serialStatusSchema,
  productId: idSchema,
  sku: z.string(),
  productName: z.string(),
  distributorId: idSchema.nullable(),
  distributorName: z.string().nullable(),
  distributorCode: z.string().nullable(),
  warehouseId: idSchema.nullable(),
  warrantyStart: z.string().nullable(),
  warrantyEnd: z.string().nullable(),
  isUnderWarranty: z.boolean(),
  dispatchedAt: dateTimeSchema.nullable(),
});
export type SerialTrace = z.infer<typeof serialTraceSchema>;

export const transferSummarySchema = z.object({
  id: idSchema,
  code: businessCodeSchema,
  status: transferStatusSchema,
  sourceWarehouseId: idSchema,
  sourceWarehouseName: z.string(),
  destinationWarehouseId: idSchema,
  destinationWarehouseName: z.string(),
  lineCount: z.number().int().nonnegative(),
  totalQuantity: z.string(),
  dispatchedAt: dateTimeSchema.nullable(),
  receivedAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
});
export type TransferSummary = z.infer<typeof transferSummarySchema>;

/** What the nightly reconciliation job reports. */
export interface ReconciliationResult {
  checkedBalances: number;
  quantityDrifts: Array<{
    balanceId: string;
    warehouseCode: string;
    sku: string;
    recorded: string;
    ledgerDerived: string;
    difference: string;
  }>;
  reservationDrifts: Array<{
    balanceId: string;
    warehouseCode: string;
    sku: string;
    recorded: string;
    activeReservationSum: string;
    difference: string;
  }>;
  /** True when nothing drifted — the boring, expected outcome. */
  clean: boolean;
}
