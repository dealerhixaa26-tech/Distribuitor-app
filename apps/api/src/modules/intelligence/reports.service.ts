import { Injectable } from '@nestjs/common';
import {
  Money,
  OUTSTANDING_INVOICE_STATUSES,
  PERMISSIONS,
  REPORT_CATALOGUE,
  REPORT_PARAMETER_SCHEMAS,
  REPORT_SYNC_ROW_LIMIT,
  hasPermission,
  type CreateReportDefinitionDto,
  type ReportOutputFormat,
  type ReportType,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import { RequestContextStore } from '../../common/context/request-context';
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../../common/errors/domain.error';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { GstReturnsService } from '../finance/gst-returns.service';
import { OutstandingService } from '../finance/outstanding.service';
import { monthWindows } from './period';

/**
 * The report catalogue. See ADR-0020.
 *
 * ── No user input becomes SQL ──────────────────────────────────────────────
 * Every report below is ordinary TypeScript reading through `prisma.db`, so the
 * scope extension bounds it (ADR-0003) without any report author having to
 * remember. That is the whole reason this is a catalogue rather than a query
 * builder: a builder would have to inject scope predicates correctly into query
 * shapes nobody anticipated, and would forget by default.
 *
 * ── Reports do not invent numbers ──────────────────────────────────────────
 * `RECEIVABLES_AGING` delegates to `OutstandingService`; `GST_SUMMARY` to
 * `GstReturnsService`. A report and a filing that disagree is worse than either
 * alone, and the report is always the one that gets believed in the room.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outstanding: OutstandingService,
    private readonly gst: GstReturnsService,
    private readonly audit: AuditService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReportsService.name);
  }

  catalogue() {
    return { reports: REPORT_CATALOGUE };
  }

  // ── Definitions ───────────────────────────────────────────────────────────

  async createDefinition(dto: CreateReportDefinitionDto, actorId: string) {
    // Validated at SAVE time. It is validated again at RUN time, because a
    // catalogue entry's parameters can change shape between the two.
    const parameters = this.validateParameters(dto.type, dto.parameters);

    const created = await this.prisma.transaction(async (tx) => {
      const definition = await tx.reportDefinition.create({
        data: {
          type: dto.type,
          name: dto.name,
          description: dto.description ?? null,
          parameters: parameters as Prisma.InputJsonValue,
          format: dto.format,
          isShared: dto.isShared,
          createdById: actorId,
        },
      });

      await this.audit.record(tx, {
        action: 'report.defined',
        entityType: 'ReportDefinition',
        entityId: definition.id,
        after: { type: dto.type, name: dto.name },
        metadata: { actorId },
      });

      return definition;
    });

    return toDefinitionSummary(created);
  }

  async listDefinitions(actorId: string) {
    const definitions = await this.prisma.db.reportDefinition.findMany({
      // A saved report is private unless shared — one person's filters are not
      // everyone's, and a list full of other people's drafts is a list nobody
      // reads.
      where: { OR: [{ createdById: actorId }, { isShared: true }] },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return definitions.map(toDefinitionSummary);
  }

  async schedule(
    id: string,
    dto: { cronExpression: string; recipients: string[]; isActive: boolean },
    actorId: string,
  ) {
    const definition = await this.loadDefinition(id);

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.reportDefinition.update({
        where: { id: definition.id },
        data: {
          cronExpression: dto.cronExpression,
          recipients: dto.recipients,
          isScheduleActive: dto.isActive,
        },
      });

      await this.audit.record(tx, {
        action: 'report.scheduled',
        entityType: 'ReportDefinition',
        entityId: id,
        after: { cron: dto.cronExpression, recipients: dto.recipients.length, active: dto.isActive },
        metadata: { actorId },
      });

      return result;
    });

    return toDefinitionSummary(updated);
  }

  async removeDefinition(id: string, actorId: string): Promise<void> {
    const definition = await this.loadDefinition(id);
    await this.prisma.transaction(async (tx) => {
      await tx.reportDefinition.softDelete({ id: definition.id });
      await this.audit.record(tx, {
        action: 'report.definition-deleted',
        entityType: 'ReportDefinition',
        entityId: id,
        metadata: { actorId },
      });
    });
  }

  // ── Execution ─────────────────────────────────────────────────────────────

  /**
   * Runs a report and records the run.
   *
   * Synchronous under `REPORT_SYNC_ROW_LIMIT`. Above it the result is truncated
   * and the run is marked so a caller knows to queue instead — a 500-row report
   * should not require a job, a poll and an email.
   */
  async run(
    input: { type: ReportType; parameters: unknown; format: ReportOutputFormat; definitionId?: string },
    actorId: string,
  ) {
    this.assertMayRun(input.type);
    const parameters = this.validateParameters(input.type, input.parameters);
    const startedAt = this.clock.now();

    const run = await this.prisma.db.reportRun.create({
      data: {
        definitionId: input.definitionId ?? null,
        type: input.type,
        status: 'RUNNING',
        format: input.format,
        // Snapshotted: a saved definition can be edited afterwards, and a run
        // must still explain its own numbers.
        parameters: parameters as Prisma.InputJsonValue,
        startedAt,
        createdById: actorId,
      },
    });

    try {
      const { columns, rows } = await this.execute(input.type, parameters);
      const truncated = rows.length > REPORT_SYNC_ROW_LIMIT;
      const output = truncated ? rows.slice(0, REPORT_SYNC_ROW_LIMIT) : rows;
      const completedAt = this.clock.now();

      await this.prisma.db.reportRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCESS',
          rowCount: rows.length,
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        },
      });

      if (input.definitionId) {
        await this.prisma.db.reportDefinition.update({
          where: { id: input.definitionId },
          data: { lastRunAt: completedAt },
        });
      }

      return {
        runId: run.id,
        type: input.type,
        columns,
        rows: output,
        rowCount: rows.length,
        truncated,
        generatedAt: completedAt,
      };
    } catch (error) {
      await this.prisma.db.reportRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message : String(error),
          completedAt: this.clock.now(),
        },
      });
      throw error;
    }
  }

  async listRuns(query: { definitionId?: string; status?: string; limit: number }) {
    const runs = await this.prisma.db.reportRun.findMany({
      where: {
        ...(query.definitionId ? { definitionId: query.definitionId } : {}),
        ...(query.status ? { status: query.status as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
    return runs.map(toRunSummary);
  }

  /** CSV, generated from the same rows the JSON response carries. */
  toCsv(columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
    const escape = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      const text = String(value);
      // RFC 4180: quote when the value contains a delimiter, quote or newline,
      // and double any embedded quote. Excel silently mangles the alternative.
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const header = columns.map(escape).join(',');
    const body = rows.map((row) => columns.map((column) => escape(row[column])).join(','));
    return [header, ...body].join('\r\n');
  }

  // ── The six reports ───────────────────────────────────────────────────────

  private async execute(
    type: ReportType,
    parameters: Record<string, unknown>,
  ): Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }> {
    const entry = REPORT_CATALOGUE.find((item) => item.type === type);
    if (!entry) throw new NotFoundError('Report type', type);

    switch (type) {
      case 'SALES_SUMMARY':
        return { columns: entry.columns, rows: await this.salesSummary(parameters) };
      case 'DISTRIBUTOR_PERFORMANCE':
        return { columns: entry.columns, rows: await this.distributorPerformance(parameters) };
      case 'PRODUCT_PERFORMANCE':
        return { columns: entry.columns, rows: await this.productPerformance(parameters) };
      case 'STOCK_VALUATION':
        return { columns: entry.columns, rows: await this.stockValuation(parameters) };
      case 'RECEIVABLES_AGING':
        return { columns: entry.columns, rows: await this.receivablesAging() };
      case 'GST_SUMMARY':
        return { columns: entry.columns, rows: await this.gstSummary(parameters) };
    }
  }

  private async salesSummary(parameters: Record<string, unknown>) {
    const from = new Date(`${String(parameters.from)}T00:00:00.000Z`);
    const to = new Date(`${String(parameters.to)}T23:59:59.999Z`);

    const months = monthWindows(
      Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (30 * 86_400_000)) + 1),
      to,
    ).filter((window) => window.to >= from && window.from <= to);

    return Promise.all(
      months.map(async (window) => {
        const result = await this.prisma.db.order.aggregate({
          where: {
            type: 'PRIMARY',
            status: { notIn: ['DRAFT', 'CANCELLED', 'REJECTED'] },
            orderDate: { gte: window.from, lte: window.to },
            ...this.partyFilter(parameters),
          },
          _sum: { taxableValue: true, totalTax: true, grandTotal: true },
          _count: { _all: true },
        });

        return {
          month: window.month,
          orderCount: result._count._all,
          taxableValue: decimal(result._sum.taxableValue),
          totalTax: decimal(result._sum.totalTax),
          grandTotal: decimal(result._sum.grandTotal),
        };
      }),
    );
  }

  private async distributorPerformance(parameters: Record<string, unknown>) {
    const from = new Date(`${String(parameters.from)}T00:00:00.000Z`);
    const to = new Date(`${String(parameters.to)}T23:59:59.999Z`);

    const distributors = await this.prisma.db.distributor.findMany({
      where: parameters.territoryId ? { territoryId: String(parameters.territoryId) } : {},
      select: { id: true, code: true, legalName: true, territory: { select: { name: true } } },
      orderBy: { legalName: 'asc' },
    });

    return Promise.all(
      distributors.map(async (distributor) => {
        const [orders, invoiced, outstanding] = await Promise.all([
          this.prisma.db.order.aggregate({
            where: {
              distributorId: distributor.id,
              type: 'PRIMARY',
              status: { notIn: ['DRAFT', 'CANCELLED', 'REJECTED'] },
              orderDate: { gte: from, lte: to },
            },
            _sum: { grandTotal: true },
            _count: { _all: true },
          }),
          this.prisma.db.invoice.aggregate({
            where: {
              distributorId: distributor.id,
              status: { notIn: ['DRAFT', 'CANCELLED'] },
              invoiceDate: { gte: from, lte: to },
            },
            _sum: { grandTotal: true },
          }),
          this.prisma.db.invoice.aggregate({
            where: {
              distributorId: distributor.id,
              status: { in: [...OUTSTANDING_INVOICE_STATUSES] },
            },
            _sum: { amountOutstanding: true },
          }),
        ]);

        return {
          distributorCode: distributor.code,
          distributorName: distributor.legalName,
          territory: distributor.territory?.name ?? '',
          orderCount: orders._count._all,
          orderValue: decimal(orders._sum.grandTotal),
          invoicedValue: decimal(invoiced._sum.grandTotal),
          outstanding: decimal(outstanding._sum.amountOutstanding),
        };
      }),
    );
  }

  private async productPerformance(parameters: Record<string, unknown>) {
    const from = new Date(`${String(parameters.from)}T00:00:00.000Z`);
    const to = new Date(`${String(parameters.to)}T23:59:59.999Z`);
    const limit = Number(parameters.limit ?? 100);

    const grouped = await this.prisma.db.orderLine.groupBy({
      by: ['productId', 'sku'],
      where: {
        order: {
          type: 'PRIMARY',
          status: { notIn: ['DRAFT', 'CANCELLED', 'REJECTED'] },
          orderDate: { gte: from, lte: to },
          ...this.partyFilter(parameters),
        },
      },
      _sum: { quantity: true, lineTotal: true },
      _count: { _all: true },
      orderBy: { _sum: { lineTotal: 'desc' } },
      take: limit,
    });

    const products = await this.prisma.db.product.findMany({
      where: { id: { in: grouped.map((row) => row.productId) } },
      select: { id: true, name: true, category: { select: { name: true } } },
    });
    const byId = new Map(products.map((product) => [product.id, product]));

    return grouped.map((row) => ({
      sku: row.sku,
      productName: byId.get(row.productId)?.name ?? row.sku,
      category: byId.get(row.productId)?.category?.name ?? '',
      quantitySold: decimal(row._sum.quantity),
      revenue: decimal(row._sum.lineTotal),
      orderCount: row._count._all,
    }));
  }

  /**
   * Stock valuation — the Phase 8 obligation.
   *
   * ⚠️ EXCLUDES `DISTRIBUTOR` warehouses from the asset figure. Those goods were
   * sold at the sell-in invoice; counting them again overstates assets
   * (ADR-0014 §4). `includeChannelSection` adds them as a LABELLED section — it
   * does not merge them into the total, and there is deliberately no parameter
   * that would.
   */
  private async stockValuation(parameters: Record<string, unknown>) {
    const includeChannel = parameters.includeChannelSection === true;

    const balances = await this.prisma.db.stockBalance.findMany({
      where: {
        quantityOnHand: { gt: 0 },
        ...(includeChannel ? {} : { warehouse: { type: { not: 'DISTRIBUTOR' } } }),
        ...(parameters.territoryId
          ? { warehouse: { territoryId: String(parameters.territoryId) } }
          : {}),
      },
      select: {
        quantityOnHand: true,
        averageCost: true,
        warehouse: { select: { code: true, name: true, type: true } },
        product: { select: { sku: true, name: true } },
      },
      orderBy: [{ warehouseId: 'asc' }],
    });

    return balances.map((balance) => ({
      warehouseCode: balance.warehouse.code,
      warehouseName:
        balance.warehouse.type === 'DISTRIBUTOR'
          ? `${balance.warehouse.name} (CHANNEL — not an owned asset)`
          : balance.warehouse.name,
      sku: balance.product.sku,
      productName: balance.product.name,
      quantityOnHand: decimal(balance.quantityOnHand),
      averageCost: decimal(balance.averageCost),
      value: Money.of(balance.quantityOnHand.toFixed(4))
        .multiply(balance.averageCost.toFixed(4))
        .toString(),
    }));
  }

  /** Delegated, not reimplemented — one definition of aging (ADR-0020). */
  private async receivablesAging() {
    const report = await this.outstanding.report({});
    return report.parties.map((party) => ({
      partyCode: party.partyCode ?? '',
      partyName: party.partyName,
      current: party.current,
      d0_30: party.d0_30,
      d31_60: party.d31_60,
      d61_90: party.d61_90,
      d90Plus: party.d90Plus,
      total: party.total,
      oldestDaysPastDue: party.oldestDaysPastDue,
    }));
  }

  /** Delegated to `GstReturnsService` — a report must not disagree with a filing. */
  private async gstSummary(parameters: Record<string, unknown>) {
    const gstr1 = await this.gst.gstr1({
      from: String(parameters.from),
      to: String(parameters.to),
    });

    const rows: Array<Record<string, unknown>> = [];

    for (const group of gstr1.b2b) {
      for (const invoice of group.inv) {
        for (const item of invoice.itms) {
          rows.push({
            supplyType: 'B2B',
            gstRate: item.itm_det.rt,
            taxableValue: item.itm_det.txval,
            cgst: item.itm_det.camt ?? 0,
            sgst: item.itm_det.samt ?? 0,
            igst: item.itm_det.iamt ?? 0,
            cess: item.itm_det.csamt ?? 0,
            total:
              (item.itm_det.txval ?? 0) +
              (item.itm_det.camt ?? 0) +
              (item.itm_det.samt ?? 0) +
              (item.itm_det.iamt ?? 0) +
              (item.itm_det.csamt ?? 0),
          });
        }
      }
    }

    for (const row of gstr1.b2cs) {
      rows.push({
        supplyType: 'B2CS',
        gstRate: row.rt,
        taxableValue: row.txval,
        cgst: row.camt ?? 0,
        sgst: row.samt ?? 0,
        igst: row.iamt ?? 0,
        cess: row.csamt ?? 0,
        total:
          row.txval + (row.camt ?? 0) + (row.samt ?? 0) + (row.iamt ?? 0) + (row.csamt ?? 0),
      });
    }

    return rows;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private partyFilter(parameters: Record<string, unknown>): Prisma.OrderWhereInput {
    return {
      ...(parameters.distributorId ? { distributorId: String(parameters.distributorId) } : {}),
      ...(parameters.territoryId
        ? {
            OR: [
              { distributor: { territoryId: String(parameters.territoryId) } },
              { customer: { territoryId: String(parameters.territoryId) } },
            ],
          }
        : {}),
    };
  }

  /**
   * Parameters are validated against the CATALOGUE entry's schema, never
   * trusted as a JSON blob (ADR-0020 §1).
   */
  private validateParameters(type: ReportType, input: unknown): Record<string, unknown> {
    const schema = REPORT_PARAMETER_SCHEMAS[type];
    const parsed = schema.safeParse(input ?? {});

    if (!parsed.success) {
      throw new ValidationError(
        `Invalid parameters for ${type}: ` +
          parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; '),
        parsed.error.issues.map((issue) => ({
          field: issue.path.join('.') || 'parameters',
          code: 'INVALID_REPORT_PARAMETER',
          message: issue.message,
        })),
      );
    }

    return parsed.data as Record<string, unknown>;
  }

  /**
   * Every report in the catalogue exposes money, so all six need
   * `analytics:read:financial` on top of `report:run`.
   *
   * Checked from the catalogue rather than hardcoded, so a future non-financial
   * report is not gated by an assumption nobody revisited.
   */
  private assertMayRun(type: ReportType): void {
    const entry = REPORT_CATALOGUE.find((item) => item.type === type);
    if (!entry?.financial) return;

    const access = RequestContextStore.get()?.access;
    if (!access || !hasPermission(access, PERMISSIONS.ANALYTICS_READ_FINANCIAL)) {
      throw new PermissionDeniedError(PERMISSIONS.ANALYTICS_READ_FINANCIAL);
    }
  }

  private async loadDefinition(id: string) {
    const definition = await this.prisma.db.reportDefinition.findFirst({ where: { id } });
    if (!definition) throw new NotFoundError('ReportDefinition', id);
    return definition;
  }
}

// ── Mapping ─────────────────────────────────────────────────────────────────

const decimal = (value: Prisma.Decimal | null | undefined): string =>
  value ? value.toFixed(4) : '0.0000';

function toDefinitionSummary(row: {
  id: string;
  type: string;
  name: string;
  description: string | null;
  parameters: Prisma.JsonValue;
  format: string;
  isShared: boolean;
  cronExpression: string | null;
  recipients: string[];
  isScheduleActive: boolean;
  lastRunAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    parameters: (row.parameters ?? {}) as Record<string, unknown>,
    format: row.format,
    isShared: row.isShared,
    cronExpression: row.cronExpression,
    recipients: row.recipients,
    isScheduleActive: row.isScheduleActive,
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
  };
}

function toRunSummary(row: {
  id: string;
  definitionId: string | null;
  type: string;
  status: string;
  format: string;
  parameters: Prisma.JsonValue;
  rowCount: number | null;
  documentId: string | null;
  durationMs: number | null;
  error: string | null;
  isScheduled: boolean;
  createdAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: row.id,
    definitionId: row.definitionId,
    type: row.type,
    status: row.status,
    format: row.format,
    parameters: (row.parameters ?? {}) as Record<string, unknown>,
    rowCount: row.rowCount,
    documentId: row.documentId,
    durationMs: row.durationMs,
    error: row.error,
    isScheduled: row.isScheduled,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}
