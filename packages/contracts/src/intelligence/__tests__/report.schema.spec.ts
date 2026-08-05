import { describe, expect, it } from 'vitest';
import {
  REPORT_CATALOGUE,
  REPORT_PARAMETER_SCHEMAS,
  REPORT_TYPES,
  createReportDefinitionSchema,
  scheduleReportSchema,
} from '../report.schema';
import { createSalesTargetSchema } from '../analytics.schema';

/**
 * ADR-0020's guarantee, asserted: a report is a TYPE plus validated
 * parameters, and there is no path by which user input becomes a query.
 */
describe('the report catalogue (ADR-0020)', () => {
  it('has a parameter schema for every type — none can be unvalidated', () => {
    for (const type of REPORT_TYPES) {
      expect(REPORT_PARAMETER_SCHEMAS[type]).toBeDefined();
    }
    expect(Object.keys(REPORT_PARAMETER_SCHEMAS).sort()).toEqual([...REPORT_TYPES].sort());
  });

  it('describes every type in the catalogue, with columns', () => {
    for (const type of REPORT_TYPES) {
      const entry = REPORT_CATALOGUE.find((item) => item.type === type);
      expect(entry, `${type} is missing from REPORT_CATALOGUE`).toBeDefined();
      expect(entry!.columns.length).toBeGreaterThan(0);
    }
  });

  it('exposes no field through which a caller could supply SQL', () => {
    // The whole ADR in one assertion. A `query`, `sql`, `where` or `select`
    // field appearing here would mean the catalogue had become a builder.
    const parsed = createReportDefinitionSchema.safeParse({
      type: 'SALES_SUMMARY',
      name: 'Anything',
      parameters: { from: '2026-04-01', to: '2026-08-05' },
      sql: 'SELECT * FROM "user"',
      query: 'DROP TABLE invoice',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'sql' in parsed.data).toBe(false);
    expect(parsed.success && 'query' in parsed.data).toBe(false);
  });

  it('rejects parameters that do not match the type', () => {
    const salesSummary = REPORT_PARAMETER_SCHEMAS.SALES_SUMMARY;
    expect(salesSummary.safeParse({ from: '2026-04-01', to: '2026-08-05' }).success).toBe(true);
    expect(salesSummary.safeParse({ from: 'yesterday' }).success).toBe(false);
    expect(salesSummary.safeParse({}).success).toBe(false);
  });

  it('gives STOCK_VALUATION no parameter that could merge channel stock into the total', () => {
    // ADR-0014 §4: channel goods are sold. `includeChannelSection` adds a
    // LABELLED section; there is deliberately no flag that adds them up.
    const parsed = REPORT_PARAMETER_SCHEMAS.STOCK_VALUATION.safeParse({
      includeChannelSection: true,
      mergeChannelIntoTotal: true,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'mergeChannelIntoTotal' in parsed.data).toBe(false);
  });

  it('marks every current report as financial, so all six are permission-gated', () => {
    expect(REPORT_CATALOGUE.every((entry) => entry.financial)).toBe(true);
  });
});

describe('scheduleReportSchema', () => {
  it('requires at least one recipient', () => {
    // An active schedule with no recipients runs forever and reaches nobody,
    // which looks like a working report until someone asks where it went.
    expect(
      scheduleReportSchema.safeParse({ cronExpression: '0 7 1 * *', recipients: [] }).success,
    ).toBe(false);
    expect(
      scheduleReportSchema.safeParse({
        cronExpression: '0 7 1 * *',
        recipients: ['owner@hixaa.com'],
      }).success,
    ).toBe(true);
  });

  it('rejects a malformed cron expression', () => {
    expect(
      scheduleReportSchema.safeParse({ cronExpression: 'daily', recipients: ['a@b.com'] }).success,
    ).toBe(false);
  });
});

describe('createSalesTargetSchema', () => {
  const base = { periodType: 'MONTH' as const, periodStart: '2026-04-01', periodEnd: '2026-04-30', targetAmount: '500000' };
  const ID = '019fcaa4-0000-7000-8000-000000000002';

  it('accepts exactly one dimension', () => {
    expect(createSalesTargetSchema.safeParse({ ...base, territoryId: ID }).success).toBe(true);
    expect(createSalesTargetSchema.safeParse({ ...base, distributorId: ID }).success).toBe(true);
    expect(createSalesTargetSchema.safeParse({ ...base, productId: ID }).success).toBe(true);
  });

  it('refuses zero dimensions and two at once', () => {
    // Mirrors the CHECK constraint. A target measuring two things is ambiguous
    // in a way that only surfaces when the achievement figure looks wrong.
    expect(createSalesTargetSchema.safeParse(base).success).toBe(false);
    expect(
      createSalesTargetSchema.safeParse({ ...base, territoryId: ID, productId: ID }).success,
    ).toBe(false);
  });

  it('refuses a period that ends before it starts', () => {
    expect(
      createSalesTargetSchema.safeParse({
        ...base,
        territoryId: ID,
        periodStart: '2026-04-30',
        periodEnd: '2026-04-01',
      }).success,
    ).toBe(false);
  });
});
