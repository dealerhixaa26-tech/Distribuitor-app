import { z } from 'zod';
import { dateOnlySchema, dateTimeSchema, idSchema } from '../primitives/common';

/**
 * Analytics contracts.
 *
 * ── Two shapes worth reading before adding a panel ─────────────────────────
 *
 * **Every money field is optional.** `analytics:read` returns operational
 * counts; `analytics:read:financial` adds revenue and receivables. A caller
 * without the financial permission gets the field ABSENT, never zeroed — a zero
 * is a claim about the business, and "we made nothing this month" is a very
 * different statement from "you may not see this".
 *
 * **Every KPI carries its own comparison.** A number without a baseline is
 * decoration; the delta is the part a person acts on.
 */

// ── Periods ─────────────────────────────────────────────────────────────────

export const ANALYTICS_PERIODS = ['TODAY', 'WTD', 'MTD', 'QTD', 'YTD', 'FYTD'] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];
export const analyticsPeriodSchema = z.enum(ANALYTICS_PERIODS);

export const analyticsQuerySchema = z.object({
  period: analyticsPeriodSchema.default('MTD'),
  /** Narrow to one territory subtree. Still bounded by the caller's own scope. */
  territoryId: idSchema.optional(),
  distributorId: idSchema.optional(),
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export const trendQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(36).default(12),
  territoryId: idSchema.optional(),
  distributorId: idSchema.optional(),
});

export type TrendQuery = z.infer<typeof trendQuerySchema>;

export const topNQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  months: z.coerce.number().int().min(1).max(36).default(12),
  territoryId: idSchema.optional(),
});

export type TopNQuery = z.infer<typeof topNQuerySchema>;

// ── KPI ─────────────────────────────────────────────────────────────────────

/**
 * One headline figure with its period-over-period comparison.
 *
 * The comparison period is the same LENGTH immediately before the current one,
 * not the whole of the previous calendar period. On the 3rd of the month, MTD
 * compares three days against the previous month's first three days — comparing
 * against a full month would report a collapse every time a month turned over,
 * and a metric that lies on the 1st is a metric nobody reads on the 2nd.
 */
export const kpiSchema = z.object({
  /** Absent when the caller lacks `analytics:read:financial` and this is money. */
  value: z.string().optional(),
  previousValue: z.string().optional(),
  /** Null when the previous period was zero — division by zero is not "+100%". */
  deltaPercent: z.string().nullable(),
  direction: z.enum(['UP', 'DOWN', 'FLAT']),
  /** True when a rise is bad — overdue receivables, dead stock. */
  inverse: z.boolean().default(false),
});

export type Kpi = z.infer<typeof kpiSchema>;

export const kpiSummarySchema = z.object({
  period: analyticsPeriodSchema,
  from: z.string(),
  to: z.string(),
  comparedFrom: z.string(),
  comparedTo: z.string(),

  /** Financial — omitted entirely without `analytics:read:financial`. */
  revenue: kpiSchema.optional(),
  outstanding: kpiSchema.optional(),
  overdue: kpiSchema.optional(),
  collected: kpiSchema.optional(),

  /** Operational — available with plain `analytics:read`. */
  orderCount: kpiSchema,
  orderValue: kpiSchema.optional(),
  quotationCount: kpiSchema,
  lowStockCount: kpiSchema,
  backorderedLineCount: kpiSchema,
});

export type KpiSummary = z.infer<typeof kpiSummarySchema>;

// ── Series and rankings ─────────────────────────────────────────────────────

export const trendPointSchema = z.object({
  /** `YYYY-MM`, the month this point covers. */
  month: z.string(),
  orderCount: z.number().int().nonnegative(),
  orderValue: z.string().optional(),
  invoicedValue: z.string().optional(),
});

export const salesTrendSchema = z.object({
  months: z.number().int(),
  points: z.array(trendPointSchema),
});

export type SalesTrend = z.infer<typeof salesTrendSchema>;

export const rankedEntrySchema = z.object({
  id: idSchema,
  label: z.string(),
  sublabel: z.string().nullable(),
  orderCount: z.number().int().nonnegative(),
  quantity: z.string().optional(),
  revenue: z.string().optional(),
  /** Share of the period's total, so a rank is readable without arithmetic. */
  sharePercent: z.string().optional(),
});

export type RankedEntry = z.infer<typeof rankedEntrySchema>;

export const rankingSchema = z.object({
  months: z.number().int(),
  total: z.string().optional(),
  entries: z.array(rankedEntrySchema),
});

// ── Inventory health ────────────────────────────────────────────────────────

/**
 * The stock picture.
 *
 * `ownedStockValue` deliberately EXCLUDES `DISTRIBUTOR` warehouses: those goods
 * were sold at the sell-in invoice, and counting them again overstates assets
 * (ADR-0014 §4, and the obligation Phase 8 placed on Phase 9).
 *
 * `channelStockValue` reports them SEPARATELY and is labelled as the partner's
 * holding, because "what do our distributors have on the shelf" is a real and
 * useful question — it is just not an asset of Hixaa's.
 */
export const inventoryHealthSchema = z.object({
  ownedStockValue: z.string().optional(),
  ownedWarehouseCount: z.number().int().nonnegative(),
  channelStockValue: z.string().optional(),
  channelWarehouseCount: z.number().int().nonnegative(),

  skusInStock: z.number().int().nonnegative(),
  lowStockCount: z.number().int().nonnegative(),
  outOfStockCount: z.number().int().nonnegative(),
  /** On hand but unsold for longer than the dead-stock threshold. */
  deadStockCount: z.number().int().nonnegative(),
  deadStockValue: z.string().optional(),
  reservedQuantity: z.string(),
});

export type InventoryHealth = z.infer<typeof inventoryHealthSchema>;

// ── Targets ─────────────────────────────────────────────────────────────────

export const targetPeriodTypeSchema = z.enum(['MONTH', 'QUARTER', 'YEAR']);

export const createSalesTargetSchema = z
  .object({
    periodType: targetPeriodTypeSchema,
    periodStart: dateOnlySchema,
    periodEnd: dateOnlySchema,
    territoryId: idSchema.optional(),
    distributorId: idSchema.optional(),
    productId: idSchema.optional(),
    targetAmount: z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'A positive decimal amount'),
    targetQuantity: z.string().optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .refine(
    (v) =>
      [v.territoryId, v.distributorId, v.productId].filter(Boolean).length === 1,
    {
      path: ['territoryId'],
      message:
        'A target measures exactly one dimension — a territory, a distributor, or a product. ' +
        'Two at once is ambiguous about what it measures.',
    },
  )
  .refine((v) => v.periodEnd >= v.periodStart, {
    path: ['periodEnd'],
    message: 'The period must end on or after it starts',
  });

export type CreateSalesTargetDto = z.infer<typeof createSalesTargetSchema>;

export const targetAchievementSchema = z.object({
  targetId: idSchema,
  dimension: z.enum(['TERRITORY', 'DISTRIBUTOR', 'PRODUCT']),
  dimensionId: idSchema,
  dimensionLabel: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  targetAmount: z.string(),
  achievedAmount: z.string(),
  /** Null when the target is zero — which the CHECK constraint forbids anyway. */
  achievementPercent: z.string().nullable(),
  /** How far through the period we are, so 40% at mid-month reads correctly. */
  periodElapsedPercent: z.string(),
  status: z.enum(['AHEAD', 'ON_TRACK', 'BEHIND', 'MISSED']),
});

export type TargetAchievement = z.infer<typeof targetAchievementSchema>;

// ── Activity feed ───────────────────────────────────────────────────────────

export const activityEntrySchema = z.object({
  id: idSchema,
  kind: z.enum(['ORDER', 'INVOICE', 'PAYMENT', 'SHIPMENT', 'QUOTATION']),
  reference: z.string(),
  description: z.string(),
  amount: z.string().optional(),
  actorName: z.string().nullable(),
  occurredAt: dateTimeSchema,
  href: z.string(),
});

export type ActivityEntry = z.infer<typeof activityEntrySchema>;

// ── Search ──────────────────────────────────────────────────────────────────

export const SEARCH_ENTITIES = [
  'INVOICE',
  'ORDER',
  'QUOTATION',
  'DISTRIBUTOR',
  'CUSTOMER',
  'PRODUCT',
] as const;
export type SearchEntity = (typeof SEARCH_ENTITIES)[number];

export const globalSearchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Type at least two characters').max(200),
  /** Per entity group. A palette is for jumping to a known thing, not browsing. */
  limit: z.coerce.number().int().min(1).max(20).default(5),
  entities: z
    .union([z.enum(SEARCH_ENTITIES), z.array(z.enum(SEARCH_ENTITIES))])
    .optional(),
});

export type GlobalSearchQuery = z.infer<typeof globalSearchQuerySchema>;

export const searchHitSchema = z.object({
  entity: z.enum(SEARCH_ENTITIES),
  id: idSchema,
  title: z.string(),
  subtitle: z.string().nullable(),
  href: z.string(),
  /** Present when the match was fuzzy rather than exact, so the UI can say so. */
  score: z.number().optional(),
});

export const globalSearchResultSchema = z.object({
  query: z.string(),
  totalHits: z.number().int().nonnegative(),
  groups: z.array(
    z.object({
      entity: z.enum(SEARCH_ENTITIES),
      label: z.string(),
      hits: z.array(searchHitSchema),
    }),
  ),
});

export type GlobalSearchResult = z.infer<typeof globalSearchResultSchema>;
