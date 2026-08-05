import { z } from 'zod';
import { dateOnlySchema, dateTimeSchema, idSchema, shortTextSchema } from '../primitives/common';

/**
 * Report contracts. See ADR-0020.
 *
 * ── There is no query in here, and that is the entire point ────────────────
 * A report is a TYPE from a fixed catalogue plus validated parameter values.
 * No user input becomes SQL, which is why every report can go through
 * `prisma.db` and inherit the scope extension (ADR-0003) instead of needing a
 * DSL that injects scope predicates into shapes nobody anticipated.
 *
 * "Builder" survives as a UI over this catalogue: pick a report, set filters,
 * name it, save it, schedule it. What a user cannot do is invent a query shape.
 */

export const REPORT_TYPES = [
  'SALES_SUMMARY',
  'DISTRIBUTOR_PERFORMANCE',
  'PRODUCT_PERFORMANCE',
  'STOCK_VALUATION',
  'RECEIVABLES_AGING',
  'GST_SUMMARY',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const reportTypeSchema = z.enum(REPORT_TYPES);

export const REPORT_FORMATS_OUT = ['CSV', 'XLSX', 'PDF'] as const;
export type ReportOutputFormat = (typeof REPORT_FORMATS_OUT)[number];
export const reportOutputFormatSchema = z.enum(REPORT_FORMATS_OUT);

export const REPORT_RUN_STATUSES = ['QUEUED', 'RUNNING', 'SUCCESS', 'FAILED'] as const;
export type ReportRunStatus = (typeof REPORT_RUN_STATUSES)[number];
export const reportRunStatusSchema = z.enum(REPORT_RUN_STATUSES);

// ── Per-type parameter schemas ──────────────────────────────────────────────

/**
 * Most reports are "a period, optionally narrowed". Declared once so the six
 * entries cannot drift apart on how they express a date range.
 */
const periodParams = z.object({
  from: dateOnlySchema,
  to: dateOnlySchema,
  territoryId: idSchema.optional(),
  distributorId: idSchema.optional(),
});

const asOfParams = z.object({
  /** Defaults to today at run time, so a saved definition stays current. */
  asOf: dateOnlySchema.optional(),
  territoryId: idSchema.optional(),
});

/**
 * The catalogue's parameter schemas, keyed by type.
 *
 * Validated at SAVE time and again at RUN time. A definition saved last month
 * against a parameter that has since changed shape fails loudly on the next run
 * rather than quietly producing a wrong report.
 */
export const REPORT_PARAMETER_SCHEMAS = {
  SALES_SUMMARY: periodParams,
  DISTRIBUTOR_PERFORMANCE: periodParams,
  PRODUCT_PERFORMANCE: periodParams.extend({
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  STOCK_VALUATION: asOfParams.extend({
    /**
     * Channel stock is reported SEPARATELY and never added to the owned figure
     * (ADR-0014 §4). This flag adds a labelled section, it does not merge them.
     */
    includeChannelSection: z.boolean().default(false),
  }),
  RECEIVABLES_AGING: asOfParams,
  GST_SUMMARY: z.object({ from: dateOnlySchema, to: dateOnlySchema }),
} as const satisfies Record<ReportType, z.ZodTypeAny>;

export type ReportParameters<T extends ReportType> = z.infer<
  (typeof REPORT_PARAMETER_SCHEMAS)[T]
>;

/** Human description of the catalogue, for the picker. */
export interface ReportCatalogueEntry {
  type: ReportType;
  name: string;
  description: string;
  /** Column keys in output order. */
  columns: string[];
  /** True when the report exposes money and needs `analytics:read:financial`. */
  financial: boolean;
}

export const REPORT_CATALOGUE: readonly ReportCatalogueEntry[] = [
  {
    type: 'SALES_SUMMARY',
    name: 'Sales summary',
    description: 'Orders and value by month over a period. Excludes SECONDARY (sell-out) orders.',
    columns: ['month', 'orderCount', 'taxableValue', 'totalTax', 'grandTotal'],
    financial: true,
  },
  {
    type: 'DISTRIBUTOR_PERFORMANCE',
    name: 'Distributor performance',
    description: 'Orders, value, invoiced and outstanding per distributor.',
    columns: [
      'distributorCode',
      'distributorName',
      'territory',
      'orderCount',
      'orderValue',
      'invoicedValue',
      'outstanding',
    ],
    financial: true,
  },
  {
    type: 'PRODUCT_PERFORMANCE',
    name: 'Product performance',
    description: 'Quantity and revenue per product over a period.',
    columns: ['sku', 'productName', 'category', 'quantitySold', 'revenue', 'orderCount'],
    financial: true,
  },
  {
    type: 'STOCK_VALUATION',
    name: 'Stock valuation',
    description:
      'Stock on hand and its value, per warehouse and product. EXCLUDES distributor-held ' +
      'channel stock from the asset figure — those goods were sold (ADR-0014 §4).',
    columns: [
      'warehouseCode',
      'warehouseName',
      'sku',
      'productName',
      'quantityOnHand',
      'averageCost',
      'value',
    ],
    financial: true,
  },
  {
    type: 'RECEIVABLES_AGING',
    name: 'Receivables aging',
    description: 'Outstanding per party, bucketed 0–30 / 31–60 / 61–90 / 90+ from the due date.',
    columns: [
      'partyCode',
      'partyName',
      'current',
      'd0_30',
      'd31_60',
      'd61_90',
      'd90Plus',
      'total',
      'oldestDaysPastDue',
    ],
    financial: true,
  },
  {
    type: 'GST_SUMMARY',
    name: 'GST summary',
    description:
      'Outward supplies by rate and supply type for a period. Presents the same figures as ' +
      'GET /gst/gstr1 rather than recomputing them.',
    columns: ['supplyType', 'gstRate', 'taxableValue', 'cgst', 'sgst', 'igst', 'cess', 'total'],
    financial: true,
  },
];

// ── Requests ────────────────────────────────────────────────────────────────

export const createReportDefinitionSchema = z.object({
  type: reportTypeSchema,
  name: shortTextSchema,
  description: z.string().trim().max(1000).optional(),
  /** Validated against `REPORT_PARAMETER_SCHEMAS[type]` in the service. */
  parameters: z.record(z.string(), z.unknown()).default({}),
  format: reportOutputFormatSchema.default('CSV'),
  isShared: z.boolean().default(false),
});

export type CreateReportDefinitionDto = z.infer<typeof createReportDefinitionSchema>;

/** An ad-hoc run with no saved definition — the common case for a one-off. */
export const runReportSchema = z.object({
  type: reportTypeSchema,
  parameters: z.record(z.string(), z.unknown()).default({}),
  format: reportOutputFormatSchema.default('CSV'),
});

export type RunReportDto = z.infer<typeof runReportSchema>;

export const scheduleReportSchema = z
  .object({
    /** Standard five-field cron. Validated for shape, not for sanity. */
    cronExpression: z
      .string()
      .trim()
      .regex(
        /^(\S+\s+){4}\S+$/,
        'A five-field cron expression, e.g. "0 7 1 * *" for 07:00 on the 1st',
      ),
    recipients: z.array(z.string().trim().toLowerCase().email()).min(1).max(20),
    isActive: z.boolean().default(true),
  })
  .describe('A schedule with no recipients runs forever and reaches nobody');

export type ScheduleReportDto = z.infer<typeof scheduleReportSchema>;

export const listReportRunsQuerySchema = z.object({
  definitionId: idSchema.optional(),
  status: reportRunStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// ── Responses ───────────────────────────────────────────────────────────────

export const reportDefinitionSummarySchema = z.object({
  id: idSchema,
  type: reportTypeSchema,
  name: z.string(),
  description: z.string().nullable(),
  parameters: z.record(z.string(), z.unknown()),
  format: reportOutputFormatSchema,
  isShared: z.boolean(),
  cronExpression: z.string().nullable(),
  recipients: z.array(z.string()),
  isScheduleActive: z.boolean(),
  lastRunAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
});

export type ReportDefinitionSummary = z.infer<typeof reportDefinitionSummarySchema>;

export const reportRunSummarySchema = z.object({
  id: idSchema,
  definitionId: idSchema.nullable(),
  type: reportTypeSchema,
  status: reportRunStatusSchema,
  format: reportOutputFormatSchema,
  parameters: z.record(z.string(), z.unknown()),
  rowCount: z.number().int().nullable(),
  documentId: idSchema.nullable(),
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
  isScheduled: z.boolean(),
  createdAt: dateTimeSchema,
  completedAt: dateTimeSchema.nullable(),
});

export type ReportRunSummary = z.infer<typeof reportRunSummarySchema>;

/**
 * A synchronous result, returned inline for a small report.
 *
 * The row cap exists because the failure mode of always-async is worse than it
 * sounds: every trivial report becomes a job, a poll and an email, and people
 * stop running reports at all.
 */
export const reportResultSchema = z.object({
  type: reportTypeSchema,
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int(),
  /** True when the result was capped and a queued run is needed for the rest. */
  truncated: z.boolean(),
  generatedAt: dateTimeSchema,
});

export type ReportResult = z.infer<typeof reportResultSchema>;

/** Above this, a run is queued rather than returned inline. */
export const REPORT_SYNC_ROW_LIMIT = 5000;
