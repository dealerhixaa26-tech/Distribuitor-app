import { Injectable } from '@nestjs/common';
import {
  CONVERTIBLE_QUOTATION_STATUSES,
  DOMAIN_EVENTS,
  canTransitionQuotation,
  type CreateQuotationDto,
  type ListQuotationsQuery,
  type QuotationStatus,
  type UpdateQuotationDto,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import { ConflictError, NotFoundError } from '../../common/errors/domain.error';
import { keysetWhere, toListResult } from '../../common/utils/pagination.util';
import { AuditService } from '../../infrastructure/database/audit.service';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../infrastructure/database/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { NumberSequenceService } from '../distributors/number-sequence.service';
import { SalesPricingHelper, type PricedLine } from './sales-pricing.helper';

/**
 * Quotations — where Hixaa's RFQ-first motion begins.
 *
 * A quotation is a PROPOSAL, so its lifecycle is deliberately looser than an
 * order's: it can be re-sent, and a rejected one can be revised. What it cannot
 * do is change after conversion — an order exists by then, and ADR-0011 froze
 * the figures.
 *
 * ── Revisions ──────────────────────────────────────────────────────────────
 * Revisions share a `groupId`, so "QT/2026-27/00042 rev 3" is one negotiation
 * rather than three unrelated documents. Revising supersedes the previous
 * revision rather than editing it — a customer may be holding the old one, and
 * rewriting a document already in someone's inbox is how disputes start.
 */
const QUOTATION_SELECT = {
  id: true,
  number: true,
  status: true,
  groupId: true,
  revision: true,
  distributorId: true,
  customerId: true,
  quotationDate: true,
  validUntil: true,
  subtotal: true,
  totalDiscount: true,
  taxableValue: true,
  totalCgst: true,
  totalSgst: true,
  totalIgst: true,
  totalTax: true,
  roundOff: true,
  grandTotal: true,
  sentAt: true,
  acceptedAt: true,
  createdAt: true,
  distributor: { select: { legalName: true } },
  customer: { select: { name: true } },
  _count: { select: { lines: true } },
} satisfies Prisma.QuotationSelect;

type QuotationRow = Prisma.QuotationGetPayload<{ select: typeof QUOTATION_SELECT }>;

@Injectable()
export class QuotationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingHelper: SalesPricingHelper,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly sequences: NumberSequenceService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(QuotationsService.name);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(query: ListQuotationsQuery) {
    const where: Prisma.QuotationWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.distributorId ? { distributorId: query.distributorId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.q ? { number: { contains: query.q.toUpperCase() } } : {}),
    };

    if (query.expiringInDays !== undefined) {
      where.status = { in: ['DRAFT', 'SENT'] };
      where.validUntil = {
        gte: this.clock.now(),
        lte: this.clock.plusDays(query.expiringInDays),
      };
    }

    const cursorWhere = keysetWhere(query.cursor);
    const rows = await this.prisma.db.quotation.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: QUOTATION_SELECT,
    });

    const totalCount = query.includeTotal
      ? await this.prisma.db.quotation.count({ where })
      : undefined;

    const result = toListResult(rows, query.limit, totalCount);
    return { ...result, data: result.data.map((row) => this.toSummary(row)) };
  }

  async findDetail(id: string) {
    const quotation = await this.prisma.db.quotation.findFirst({
      where: { id },
      select: QUOTATION_SELECT,
    });
    if (!quotation) throw new NotFoundError('Quotation', id);

    const [lines, siblings] = await Promise.all([
      this.prisma.db.quotationLine.findMany({
        where: { quotationId: id },
        orderBy: { lineNumber: 'asc' },
        select: LINE_SELECT,
      }),
      // Every revision in the group, so the negotiation reads as one thread.
      this.prisma.db.quotation.findMany({
        where: { groupId: quotation.groupId },
        orderBy: { revision: 'desc' },
        select: { id: true, number: true, revision: true, status: true, grandTotal: true, createdAt: true },
      }),
    ]);

    return {
      ...this.toSummary(quotation),
      lines: lines.map(toLineSummary),
      revisions: siblings.map((sibling) => ({
        ...sibling,
        grandTotal: sibling.grandTotal.toFixed(4),
      })),
    };
  }

  // ── Create and re-price ───────────────────────────────────────────────────

  async create(dto: CreateQuotationDto, actorId: string) {
    const counterparty = await this.resolveCounterparty(dto.distributorId, dto.customerId);
    const quotationDate = dto.quotationDate ?? this.toDateOnly(this.clock.now());

    const priced = await this.pricingHelper.priceLines({
      lines: dto.lines,
      distributorId: dto.distributorId ?? null,
      priceListId: dto.priceListId ?? null,
      placeOfSupplyStateCode: dto.placeOfSupplyStateCode ?? counterparty.stateCode,
      asOf: quotationDate,
      actorId,
    });

    const created = await this.prisma.transaction(async (tx) => {
      const number = await this.sequences.next(tx, 'QUOTATION');

      const quotation = await tx.quotation.create({
        data: {
          number,
          status: 'DRAFT',
          // A brand-new quotation starts its own group; revisions join it.
          groupId: crypto.randomUUID(),
          revision: 1,
          distributorId: dto.distributorId ?? null,
          customerId: dto.customerId ?? null,
          placeOfSupplyStateCode:
            dto.placeOfSupplyStateCode ?? counterparty.stateCode ?? null,
          priceListId: dto.priceListId ?? null,
          quotationDate: new Date(`${quotationDate}T00:00:00.000Z`),
          validUntil: dto.validUntil ? new Date(`${dto.validUntil}T00:00:00.000Z`) : null,
          termsAndConditions: dto.termsAndConditions ?? null,
          notes: dto.notes ?? null,
          createdById: actorId,
          ...priced.totals,
          lines: { createMany: { data: priced.lines.map(toLineData) } },
        },
        select: QUOTATION_SELECT,
      });

      await this.audit.record(tx, {
        action: 'quotation.created',
        entityType: 'Quotation',
        entityId: quotation.id,
        after: { number, lines: dto.lines.length, grandTotal: priced.totals.grandTotal },
      });

      return quotation;
    });

    this.logger.info({ quotationId: created.id, number: created.number }, 'Quotation created');
    return { ...this.toSummary(created), requiresApproval: linesNeedingApproval(priced.lines) };
  }

  /**
   * Replaces the lines on a DRAFT quotation and re-prices.
   *
   * DRAFT only. A SENT quotation is a document the customer is holding; changing
   * it silently would mean the two of you are looking at different numbers.
   * Use `revise()` instead, which supersedes visibly.
   */
  async update(id: string, dto: UpdateQuotationDto, actorId: string) {
    const quotation = await this.load(id);

    if (quotation.status !== 'DRAFT') {
      throw new ConflictError(
        `Quotation ${quotation.number} is ${quotation.status} and cannot be edited. ` +
          'Create a revision instead — the customer may already be holding this version.',
      );
    }

    const priced = dto.lines
      ? await this.pricingHelper.priceLines({
          lines: dto.lines,
          distributorId: quotation.distributorId,
          priceListId: quotation.priceListId,
          placeOfSupplyStateCode:
            dto.placeOfSupplyStateCode ?? quotation.placeOfSupplyStateCode,
          asOf: this.toDateOnly(quotation.quotationDate),
          actorId,
        })
      : null;

    const updated = await this.prisma.transaction(async (tx) => {
      if (priced) {
        // Lines have no independent identity — they are the document's content,
        // so replacing them wholesale is correct and avoids a diffing dance.
        await tx.quotationLine.deleteMany({ where: { quotationId: id } });
        await tx.quotationLine.createMany({
          data: priced.lines.map((line) => ({ ...toLineData(line), quotationId: id })),
        });
      }

      const result = await tx.quotation.update({
        where: { id },
        data: {
          ...(dto.validUntil !== undefined
            ? { validUntil: dto.validUntil ? new Date(`${dto.validUntil}T00:00:00.000Z`) : null }
            : {}),
          ...(dto.placeOfSupplyStateCode !== undefined
            ? { placeOfSupplyStateCode: dto.placeOfSupplyStateCode }
            : {}),
          ...(dto.termsAndConditions !== undefined
            ? { termsAndConditions: dto.termsAndConditions }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(priced ? priced.totals : {}),
        },
        select: QUOTATION_SELECT,
      });

      await this.audit.record(tx, {
        action: 'quotation.updated',
        entityType: 'Quotation',
        entityId: id,
        after: priced
          ? { lines: priced.lines.length, grandTotal: priced.totals.grandTotal }
          : { validUntil: dto.validUntil ?? null },
        metadata: { actorId },
      });

      return result;
    });

    return this.toSummary(updated);
  }

  /**
   * Re-runs the pricing engine and reports what moved.
   *
   * Deliberately does NOT write. Re-pricing is explicit (ADR-0011): a price
   * list may have been republished or a GST rate superseded since this was
   * quoted, and silently adopting new numbers is exactly what the snapshot
   * design exists to prevent. This shows the difference; applying it is a
   * separate `update()`.
   */
  async repricePreview(id: string, actorId: string) {
    const quotation = await this.load(id);

    const lines = await this.prisma.db.quotationLine.findMany({
      where: { quotationId: id },
      orderBy: { lineNumber: 'asc' },
      select: { productId: true, variantId: true, quantity: true, lineTotal: true, sku: true },
    });

    const priced = await this.pricingHelper.priceLines({
      lines: lines.map((line) => ({
        productId: line.productId,
        ...(line.variantId ? { variantId: line.variantId } : {}),
        quantity: line.quantity.toFixed(4),
      })),
      distributorId: quotation.distributorId,
      priceListId: quotation.priceListId,
      placeOfSupplyStateCode: quotation.placeOfSupplyStateCode,
      // Today, not the quotation date — the whole question is "what would this
      // cost now?"
      actorId,
    });

    const changes = priced.lines
      .map((line, index) => {
        const original = lines[index];
        if (!original) return null;
        const was = original.lineTotal.toFixed(4);
        return was === line.lineTotal
          ? null
          : { sku: line.sku, was, now: line.lineTotal };
      })
      .filter((change): change is { sku: string; was: string; now: string } => change !== null);

    return {
      quotedTotal: quotation.grandTotal.toFixed(4),
      currentTotal: priced.totals.grandTotal,
      unchanged: changes.length === 0,
      changes,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async send(id: string, to: string[] | undefined, message: string | undefined, actorId: string) {
    const quotation = await this.load(id);
    this.assertTransition(quotation.status, 'SENT', quotation.number);

    if (quotation.lineCount === 0) {
      throw new ConflictError(`Quotation ${quotation.number} has no lines to send.`);
    }

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.quotation.update({
        where: { id },
        data: { status: 'SENT', sentAt: this.clock.now() },
        select: QUOTATION_SELECT,
      });

      await this.audit.record(tx, {
        action: 'quotation.sent',
        entityType: 'Quotation',
        entityId: id,
        after: { status: 'SENT', to: to?.join(', ') ?? null },
        metadata: { actorId },
      });

      // The PDF is rendered and emailed by the worker — no third-party call
      // ever sits on a request path (ADR-0005).
      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.QUOTATION_SENT,
        { type: 'Quotation', id },
        {
          number: quotation.number,
          grandTotal: quotation.grandTotal.toFixed(4),
          to: to?.join(',') ?? '',
          message: message ?? '',
        },
      );

      return result;
    });

    return this.toSummary(updated);
  }

  /**
   * Supersedes a quotation with a new revision in the same group.
   *
   * The previous revision is left exactly as it was and marked REJECTED, so the
   * document the customer holds still exists and still says what it said.
   */
  async revise(id: string, dto: UpdateQuotationDto, actorId: string) {
    const quotation = await this.load(id);

    if (quotation.status === 'CONVERTED') {
      throw new ConflictError(
        `Quotation ${quotation.number} has already become an order. Raise a new quotation instead.`,
      );
    }

    const existingLines = await this.prisma.db.quotationLine.findMany({
      where: { quotationId: id },
      orderBy: { lineNumber: 'asc' },
      select: { productId: true, variantId: true, quantity: true, notes: true },
    });

    const lineInputs =
      dto.lines ??
      existingLines.map((line) => ({
        productId: line.productId,
        ...(line.variantId ? { variantId: line.variantId } : {}),
        quantity: line.quantity.toFixed(4),
        ...(line.notes ? { notes: line.notes } : {}),
      }));

    const quotationDate = this.toDateOnly(this.clock.now());
    const priced = await this.pricingHelper.priceLines({
      lines: lineInputs,
      distributorId: quotation.distributorId,
      priceListId: quotation.priceListId,
      placeOfSupplyStateCode:
        dto.placeOfSupplyStateCode ?? quotation.placeOfSupplyStateCode,
      asOf: quotationDate,
      actorId,
    });

    const created = await this.prisma.transaction(async (tx) => {
      const number = await this.sequences.next(tx, 'QUOTATION');

      const revision = await tx.quotation.create({
        data: {
          number,
          status: 'DRAFT',
          groupId: quotation.groupId,
          revision: quotation.revision + 1,
          distributorId: quotation.distributorId,
          customerId: quotation.customerId,
          placeOfSupplyStateCode:
            dto.placeOfSupplyStateCode ?? quotation.placeOfSupplyStateCode,
          priceListId: quotation.priceListId,
          quotationDate: new Date(`${quotationDate}T00:00:00.000Z`),
          validUntil: dto.validUntil
            ? new Date(`${dto.validUntil}T00:00:00.000Z`)
            : quotation.validUntil,
          termsAndConditions: dto.termsAndConditions ?? quotation.termsAndConditions,
          notes: dto.notes ?? quotation.notes,
          createdById: actorId,
          ...priced.totals,
          lines: { createMany: { data: priced.lines.map(toLineData) } },
        },
        select: QUOTATION_SELECT,
      });

      // Superseded, not deleted. The old document still exists and still says
      // what the customer was told.
      await tx.quotation.update({
        where: { id },
        data: {
          status: 'REJECTED',
          rejectedAt: this.clock.now(),
          rejectionReason: `Superseded by revision ${revision.revision} (${number})`,
        },
      });

      await this.audit.record(tx, {
        action: 'quotation.revised',
        entityType: 'Quotation',
        entityId: revision.id,
        before: { number: quotation.number, revision: quotation.revision },
        after: { number, revision: revision.revision },
        metadata: { actorId },
      });

      return revision;
    });

    return this.toSummary(created);
  }

  async accept(id: string, actorId: string) {
    const quotation = await this.load(id);
    this.assertTransition(quotation.status, 'ACCEPTED', quotation.number);

    if (quotation.validUntil && quotation.validUntil < this.clock.now()) {
      throw new ConflictError(
        `Quotation ${quotation.number} lapsed on ${this.toDateOnly(quotation.validUntil)}. ` +
          'Revise it — prices and tax rates may have moved since.',
      );
    }

    return this.transition(id, 'ACCEPTED', actorId, {
      action: 'quotation.accepted',
      event: DOMAIN_EVENTS.QUOTATION_ACCEPTED,
      number: quotation.number,
    });
  }

  async reject(id: string, reason: string, actorId: string) {
    const quotation = await this.load(id);
    this.assertTransition(quotation.status, 'REJECTED', quotation.number);
    return this.transition(id, 'REJECTED', actorId, {
      action: 'quotation.rejected',
      number: quotation.number,
      reason,
    });
  }

  /** Marks lapsed quotations EXPIRED. Run by the maintenance job. */
  async expireLapsed(): Promise<number> {
    const lapsed = await this.prisma.db.quotation.findMany({
      where: { status: 'SENT', validUntil: { not: null, lt: this.clock.now() } },
      select: { id: true },
      take: 500,
    });

    for (const row of lapsed) {
      await this.prisma.db.quotation.update({
        where: { id: row.id },
        data: { status: 'EXPIRED' },
      });
    }

    if (lapsed.length > 0) this.logger.info({ expired: lapsed.length }, 'Quotations expired');
    return lapsed.length;
  }

  /** Only an ACCEPTED quotation may become an order. Read by OrdersService. */
  async assertConvertible(id: string) {
    const quotation = await this.load(id);

    if (!CONVERTIBLE_QUOTATION_STATUSES.includes(quotation.status)) {
      throw new ConflictError(
        `Quotation ${quotation.number} is ${quotation.status}. Only an ACCEPTED quotation ` +
          'can become an order — converting a draft would commit terms nobody agreed to.',
      );
    }
    return quotation;
  }

  async markConverted(tx: PrismaTransaction, id: string): Promise<void> {
    await tx.quotation.update({ where: { id }, data: { status: 'CONVERTED' } });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async transition(
    id: string,
    to: QuotationStatus,
    actorId: string,
    options: { action: string; event?: string; reason?: string; number: string },
  ) {
    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.quotation.update({
        where: { id },
        data: {
          status: to,
          ...(to === 'ACCEPTED' ? { acceptedAt: this.clock.now() } : {}),
          ...(to === 'REJECTED'
            ? { rejectedAt: this.clock.now(), rejectionReason: options.reason ?? null }
            : {}),
        },
        select: QUOTATION_SELECT,
      });

      await this.audit.record(tx, {
        action: options.action,
        entityType: 'Quotation',
        entityId: id,
        after: { status: to },
        metadata: { actorId, reason: options.reason },
      });

      if (options.event) {
        await this.outbox.emit(
          tx,
          options.event as never,
          { type: 'Quotation', id },
          { number: options.number, status: to },
        );
      }

      return result;
    });

    return this.toSummary(updated);
  }

  private async load(id: string) {
    const quotation = await this.prisma.db.quotation.findFirst({
      where: { id },
      select: {
        id: true,
        number: true,
        status: true,
        groupId: true,
        revision: true,
        distributorId: true,
        customerId: true,
        priceListId: true,
        placeOfSupplyStateCode: true,
        quotationDate: true,
        validUntil: true,
        grandTotal: true,
        termsAndConditions: true,
        notes: true,
        _count: { select: { lines: true } },
      },
    });
    if (!quotation) throw new NotFoundError('Quotation', id);
    return { ...quotation, lineCount: quotation._count.lines };
  }

  private assertTransition(from: QuotationStatus, to: QuotationStatus, number: string): void {
    if (!canTransitionQuotation(from, to)) {
      throw new ConflictError(`Quotation ${number} cannot move from ${from} to ${to}.`);
    }
  }

  /**
   * Resolves who the quotation is for, and the place of supply that follows.
   *
   * Reads through the scoped client, so quoting to a distributor outside the
   * caller's territory is a 404 rather than a leak.
   */
  private async resolveCounterparty(distributorId?: string, customerId?: string) {
    if (distributorId) {
      const distributor = await this.prisma.db.distributor.findFirst({
        where: { id: distributorId },
        select: { id: true, gstin: true, status: true },
      });
      if (!distributor) throw new NotFoundError('Distributor', distributorId);
      return { stateCode: distributor.gstin ? distributor.gstin.slice(0, 2) : null };
    }

    if (customerId) {
      const customer = await this.prisma.db.customer.findFirst({
        where: { id: customerId },
        select: { id: true, gstin: true },
      });
      if (!customer) throw new NotFoundError('Customer', customerId);
      return { stateCode: customer.gstin ? customer.gstin.slice(0, 2) : null };
    }

    return { stateCode: null };
  }

  private toSummary(row: QuotationRow) {
    const validUntil = row.validUntil;
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      groupId: row.groupId,
      revision: row.revision,
      distributorId: row.distributorId,
      distributorName: row.distributor?.legalName ?? null,
      customerId: row.customerId,
      customerName: row.customer?.name ?? null,
      quotationDate: this.toDateOnly(row.quotationDate),
      validUntil: validUntil ? this.toDateOnly(validUntil) : null,
      // Computed, never stored — a stored flag goes stale the moment the clock
      // passes it and nothing writes to the row.
      isExpired: validUntil !== null && validUntil < this.clock.now(),
      subtotal: row.subtotal.toFixed(4),
      totalDiscount: row.totalDiscount.toFixed(4),
      taxableValue: row.taxableValue.toFixed(4),
      totalCgst: row.totalCgst.toFixed(4),
      totalSgst: row.totalSgst.toFixed(4),
      totalIgst: row.totalIgst.toFixed(4),
      totalTax: row.totalTax.toFixed(4),
      roundOff: row.roundOff.toFixed(4),
      grandTotal: row.grandTotal.toFixed(4),
      lineCount: row._count.lines,
      sentAt: row.sentAt,
      acceptedAt: row.acceptedAt,
      createdAt: row.createdAt,
    };
  }

  private toDateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}

const LINE_SELECT = {
  id: true,
  lineNumber: true,
  productId: true,
  variantId: true,
  sku: true,
  description: true,
  quantity: true,
  uomCode: true,
  unitListPrice: true,
  unitPrice: true,
  discountAmount: true,
  discountPercent: true,
  overrideReason: true,
  taxableValue: true,
  hsnSacCode: true,
  gstRate: true,
  cgst: true,
  sgst: true,
  igst: true,
  totalTax: true,
  lineTotal: true,
} satisfies Prisma.QuotationLineSelect;

type LineRow = Prisma.QuotationLineGetPayload<{ select: typeof LINE_SELECT }>;

/** Maps a priced line onto the columns a quotation line stores (ADR-0011). */
export function toLineData(line: PricedLine) {
  return {
    lineNumber: line.lineNumber,
    productId: line.productId,
    variantId: line.variantId,
    sku: line.sku,
    description: line.description,
    productRevision: line.productRevision,
    quantity: line.quantity,
    uomCode: line.uomCode,
    unitListPrice: line.unitListPrice,
    unitPrice: line.unitPrice,
    discountAmount: line.discountAmount,
    discountPercent: line.discountPercent,
    discountRuleId: line.discountRuleId,
    overrideReason: line.overrideReason,
    taxableValue: line.taxableValue,
    hsnSacCode: line.hsnSacCode,
    gstRate: line.gstRate,
    cgst: line.cgst,
    sgst: line.sgst,
    igst: line.igst,
    cess: line.cess,
    totalTax: line.totalTax,
    lineTotal: line.lineTotal,
    notes: line.notes,
  };
}

function toLineSummary(row: LineRow) {
  return {
    id: row.id,
    lineNumber: row.lineNumber,
    productId: row.productId,
    variantId: row.variantId,
    sku: row.sku,
    description: row.description,
    quantity: row.quantity.toFixed(4),
    uomCode: row.uomCode,
    unitListPrice: row.unitListPrice.toFixed(4),
    unitPrice: row.unitPrice.toFixed(4),
    discountAmount: row.discountAmount.toFixed(4),
    discountPercent: row.discountPercent.toFixed(4),
    overrideReason: row.overrideReason,
    taxableValue: row.taxableValue.toFixed(4),
    hsnSacCode: row.hsnSacCode,
    gstRate: row.gstRate.toFixed(2),
    cgst: row.cgst.toFixed(4),
    sgst: row.sgst.toFixed(4),
    igst: row.igst.toFixed(4),
    totalTax: row.totalTax.toFixed(4),
    lineTotal: row.lineTotal.toFixed(4),
  };
}

/** Lines whose override breached a ceiling — surfaced so the UI can warn. */
function linesNeedingApproval(lines: readonly PricedLine[]): string[] {
  return lines.filter((line) => line.requiresApproval).flatMap((line) => line.approvalReasons);
}
