import { Injectable } from '@nestjs/common';
import {
  DOMAIN_EVENTS,
  GST_STATE_CODES,
  Money,
  canTransitionInvoice,
  daysPastDue,
  isOverdue,
  isValidGstin,
  stateCodeFromGstin,
  type CreateInvoiceDto,
  type CreateInvoiceFromOrderDto,
  type InvoiceStatus,
  type ListInvoicesQuery,
  type SupplyType,
  type UpdateInvoiceDto,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import {
  ConflictError,
  ImmutableRecordError,
  InvoiceIssueRefusedError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain.error';
import { keysetWhere, toListResult } from '../../common/utils/pagination.util';
import { AuditService } from '../../infrastructure/database/audit.service';
import type { PrismaTransaction } from '../../infrastructure/database/prisma.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { NumberSequenceService } from '../distributors/number-sequence.service';
import { PricingService } from '../pricing/pricing.service';
import { GstCalculator } from '../pricing/gst-calculator';
import { SalesPricingHelper } from '../sales/sales-pricing.helper';
import { SettingsService } from '../settings/settings.service';
import { LedgerService } from './ledger.service';

/**
 * Invoicing — the phase's legal exposure, concentrated in one method.
 *
 * ── What this service does NOT do ──────────────────────────────────────────
 * It does not decide a price. An order-derived invoice COPIES the order line's
 * snapshot (ADR-0011); a direct invoice delegates to `PricingService.quote()`
 * through the same `SalesPricingHelper` quotations and orders already use.
 * Re-pricing at invoice time would bill today's numbers for what was agreed
 * weeks ago, which is the precise failure the snapshot design prevents.
 *
 * It does not move stock. Dispatch did that. An invoice is a financial document
 * about goods that have already left.
 *
 * It does not enforce immutability on its own. `update()` refuses politely, and
 * a database trigger refuses absolutely (ADR-0016). Removing the service check
 * would make the API rude; removing the trigger would make the guarantee a
 * convention.
 */
const INVOICE_SELECT = {
  id: true,
  number: true,
  status: true,
  supplyType: true,
  isReverseCharge: true,
  distributorId: true,
  customerId: true,
  orderId: true,
  counterpartyName: true,
  counterpartyGstin: true,
  supplierStateCode: true,
  placeOfSupplyStateCode: true,
  invoiceDate: true,
  dueDate: true,
  paymentTermsCode: true,
  subtotal: true,
  totalDiscount: true,
  taxableValue: true,
  totalCgst: true,
  totalSgst: true,
  totalIgst: true,
  totalCess: true,
  totalTax: true,
  roundOff: true,
  grandTotal: true,
  amountPaid: true,
  amountCredited: true,
  amountOutstanding: true,
  issuedAt: true,
  sentAt: true,
  cancelledAt: true,
  cancelledReason: true,
  createdAt: true,
  distributor: { select: { legalName: true } },
  customer: { select: { name: true } },
  order: { select: { number: true, type: true } },
  lines: { select: { id: true } },
} satisfies Prisma.InvoiceSelect;

type InvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_SELECT }>;

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly salesPricing: SalesPricingHelper,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly sequences: NumberSequenceService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InvoicesService.name);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(query: ListInvoicesQuery) {
    const where = this.buildWhere(query);
    const cursorWhere = keysetWhere(query.cursor);

    const rows = await this.prisma.db.invoice.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: INVOICE_SELECT,
    });

    const totalCount = query.includeTotal
      ? await this.prisma.db.invoice.count({ where })
      : undefined;

    const result = toListResult(rows, query.limit, totalCount);
    return { ...result, data: result.data.map((row) => this.toSummary(row)) };
  }

  async findDetail(id: string) {
    const invoice = await this.prisma.db.invoice.findFirst({
      where: { id },
      select: INVOICE_SELECT,
    });
    if (!invoice) throw new NotFoundError('Invoice', id);

    const [lines, allocations, notes] = await Promise.all([
      this.prisma.db.invoiceLine.findMany({
        where: { invoiceId: id },
        orderBy: { lineNumber: 'asc' },
      }),
      this.prisma.db.paymentAllocation.findMany({
        where: { invoiceId: id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          amount: true,
          tdsPortion: true,
          payment: {
            select: {
              id: true,
              number: true,
              paymentDate: true,
              method: true,
              referenceNumber: true,
            },
          },
        },
      }),
      this.prisma.db.taxNote.findMany({
        where: { originalInvoiceId: id, status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          type: true,
          number: true,
          status: true,
          reason: true,
          noteDate: true,
          grandTotal: true,
        },
      }),
    ]);

    return {
      ...this.toSummary(invoice),
      lines: lines.map((line) => ({
        id: line.id,
        lineNumber: line.lineNumber,
        productId: line.productId,
        variantId: line.variantId,
        orderLineId: line.orderLineId,
        sku: line.sku,
        description: line.description,
        quantity: line.quantity.toFixed(4),
        uomCode: line.uomCode,
        unitListPrice: line.unitListPrice.toFixed(4),
        unitPrice: line.unitPrice.toFixed(4),
        discountAmount: line.discountAmount.toFixed(4),
        discountPercent: line.discountPercent.toFixed(4),
        taxableValue: line.taxableValue.toFixed(4),
        hsnSacCode: line.hsnSacCode,
        gstRate: line.gstRate.toFixed(2),
        cgst: line.cgst.toFixed(4),
        sgst: line.sgst.toFixed(4),
        igst: line.igst.toFixed(4),
        cess: line.cess.toFixed(4),
        totalTax: line.totalTax.toFixed(4),
        lineTotal: line.lineTotal.toFixed(4),
        taxRateId: line.taxRateId,
      })),
      settlements: allocations.map((allocation) => ({
        paymentId: allocation.payment.id,
        paymentNumber: allocation.payment.number,
        paymentDate: allocation.payment.paymentDate.toISOString().slice(0, 10),
        method: allocation.payment.method,
        amount: allocation.amount.toFixed(4),
        tdsPortion: allocation.tdsPortion.toFixed(4),
        referenceNumber: allocation.payment.referenceNumber,
      })),
      taxNotes: notes.map((note) => ({
        id: note.id,
        type: note.type,
        number: note.number,
        status: note.status,
        reason: note.reason,
        noteDate: note.noteDate.toISOString().slice(0, 10),
        grandTotal: note.grandTotal.toFixed(4),
      })),
    };
  }

  // ── Drafting ──────────────────────────────────────────────────────────────

  /**
   * Bills an order, copying its snapshot.
   *
   * The default is "everything not yet billed", computed per line from what
   * previous invoices already carry. Billing an order twice by accident is the
   * obvious hazard here, and it is prevented by arithmetic rather than by a
   * status flag — a status would have to be maintained, and part-billing an
   * order is normal rather than exceptional.
   */
  async createFromOrder(orderId: string, dto: CreateInvoiceFromOrderDto, actorId: string) {
    const order = await this.loadOrderForBilling(orderId);
    const invoiceDate = dto.invoiceDate ?? this.today();

    const alreadyBilled = await this.billedQuantitiesFor(orderId);

    const requested = dto.lines
      ? new Map(dto.lines.map((line) => [line.orderLineId, Money.of(line.quantity)]))
      : null;

    const lines: DraftLine[] = [];
    for (const orderLine of order.lines) {
      const billed = alreadyBilled.get(orderLine.id) ?? Money.zero();
      const remaining = Money.of(orderLine.quantity.toFixed(4)).subtract(billed);

      const wanted = requested ? (requested.get(orderLine.id) ?? Money.zero()) : remaining;
      if (wanted.isZero()) continue;

      if (wanted.gt(remaining)) {
        throw new ConflictError(
          `${orderLine.sku}: cannot invoice ${wanted.toDisplayString()} — ` +
            `${billed.toDisplayString()} of ${Money.of(orderLine.quantity.toFixed(4)).toDisplayString()} ` +
            'is already invoiced.',
        );
      }

      // Line numbers are assigned over the lines that SURVIVE the filter above,
      // so a part-invoice reads 1, 2, 3 rather than inheriting the order's gaps.
      lines.push({ ...this.orderLineToDraft(orderLine, wanted), lineNumber: lines.length + 1 });
    }

    if (lines.length === 0) {
      throw new ConflictError(
        `Order ${order.number} is fully invoiced — there is nothing left to bill.`,
      );
    }

    const supplierStateCode = await this.supplierStateCode();
    const placeOfSupply = order.placeOfSupplyStateCode ?? supplierStateCode;

    return this.persistDraft({
      order,
      distributorId: order.distributorId,
      customerId: order.customerId,
      supplierStateCode,
      placeOfSupplyStateCode: placeOfSupply,
      invoiceDate,
      paymentTermsCode: dto.paymentTermsCode ?? order.paymentTermsCode,
      customerPoNumber: order.customerPoNumber,
      customerPoDate: order.customerPoDate,
      isReverseCharge: false,
      lines,
      notes: dto.notes ?? null,
      termsAndConditions: dto.termsAndConditions ?? null,
      actorId,
    });
  }

  /** Bills exactly what one shipment carried — the honest default for a part-shipped order. */
  async createFromShipment(shipmentId: string, dto: CreateInvoiceFromOrderDto, actorId: string) {
    const shipment = await this.prisma.db.shipment.findFirst({
      where: { id: shipmentId },
      select: {
        id: true,
        number: true,
        status: true,
        orderId: true,
        lines: { select: { orderLineId: true, quantity: true } },
      },
    });
    if (!shipment) throw new NotFoundError('Shipment', shipmentId);

    if (shipment.status === 'PENDING' || shipment.status === 'PACKED') {
      throw new ConflictError(
        `Shipment ${shipment.number} is ${shipment.status}. Invoice it once the goods have left — ` +
          'a tax invoice for an undispatched consignment declares a supply that has not happened.',
      );
    }

    return this.createFromOrder(
      shipment.orderId,
      {
        ...dto,
        lines: shipment.lines.map((line) => ({
          orderLineId: line.orderLineId,
          quantity: line.quantity.toFixed(4),
        })),
      },
      actorId,
    );
  }

  /**
   * A direct invoice — no order behind it.
   *
   * The ONLY caller of the pricing engine in this module, routed through the
   * same `SalesPricingHelper` a quotation and an order use, so a direct invoice
   * cannot be priced by a different set of rules than everything else.
   */
  async create(dto: CreateInvoiceDto, actorId: string) {
    const supplierStateCode = await this.supplierStateCode();
    const invoiceDate = dto.invoiceDate ?? this.today();

    const counterparty = await this.loadCounterparty(dto.distributorId, dto.customerId);
    const placeOfSupply =
      dto.placeOfSupplyStateCode ??
      (counterparty.gstin ? stateCodeFromGstin(counterparty.gstin) : supplierStateCode);

    const priced = await this.salesPricing.priceLines({
      lines: dto.lines,
      distributorId: dto.distributorId ?? null,
      priceListId: dto.priceListId ?? null,
      placeOfSupplyStateCode: placeOfSupply,
      asOf: invoiceDate,
      actorId,
    });

    const lines: DraftLine[] = priced.lines.map((line) => ({
      lineNumber: line.lineNumber,
      productId: line.productId,
      variantId: line.variantId,
      orderLineId: null,
      sku: line.sku,
      description: line.description,
      productRevision: line.productRevision,
      quantity: line.quantity,
      uomCode: line.uomCode,
      unitListPrice: line.unitListPrice,
      unitPrice: line.unitPrice,
      discountAmount: line.discountAmount,
      discountPercent: line.discountPercent,
      taxableValue: line.taxableValue,
      hsnSacCode: line.hsnSacCode,
      gstRate: line.gstRate,
      cessRate: '0',
      cgst: line.cgst,
      sgst: line.sgst,
      igst: line.igst,
      cess: line.cess,
      totalTax: line.totalTax,
      lineTotal: line.lineTotal,
      notes: line.notes,
    }));

    return this.persistDraft({
      order: null,
      distributorId: dto.distributorId ?? null,
      customerId: dto.customerId ?? null,
      supplierStateCode,
      placeOfSupplyStateCode: placeOfSupply,
      invoiceDate,
      paymentTermsCode: dto.paymentTermsCode ?? null,
      customerPoNumber: dto.customerPoNumber ?? null,
      customerPoDate: dto.customerPoDate ? new Date(dto.customerPoDate) : null,
      isReverseCharge: dto.isReverseCharge,
      lines,
      notes: dto.notes ?? null,
      termsAndConditions: dto.termsAndConditions ?? null,
      actorId,
    });
  }

  async update(id: string, dto: UpdateInvoiceDto, actorId: string) {
    const invoice = await this.load(id);
    this.assertDraft(invoice, 'edited');

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.invoice.update({
        where: { id },
        data: {
          ...(dto.invoiceDate ? { invoiceDate: new Date(dto.invoiceDate) } : {}),
          ...(dto.paymentTermsCode !== undefined
            ? { paymentTermsCode: dto.paymentTermsCode }
            : {}),
          ...(dto.placeOfSupplyStateCode
            ? { placeOfSupplyStateCode: dto.placeOfSupplyStateCode }
            : {}),
          ...(dto.customerPoNumber !== undefined
            ? { customerPoNumber: dto.customerPoNumber }
            : {}),
          ...(dto.customerPoDate ? { customerPoDate: new Date(dto.customerPoDate) } : {}),
          ...(dto.isReverseCharge !== undefined ? { isReverseCharge: dto.isReverseCharge } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.termsAndConditions !== undefined
            ? { termsAndConditions: dto.termsAndConditions }
            : {}),
        },
        select: INVOICE_SELECT,
      });

      await this.audit.record(tx, {
        action: 'invoice.updated',
        entityType: 'Invoice',
        entityId: id,
        after: { ...dto },
        metadata: { actorId },
      });

      return result;
    });

    // Place of supply drives the CGST/SGST vs IGST split, so changing it makes
    // every stored tax figure wrong. Re-derive rather than leaving a document
    // whose header and lines disagree.
    if (dto.placeOfSupplyStateCode && dto.placeOfSupplyStateCode !== invoice.placeOfSupplyStateCode) {
      return this.recomputeTax(id, actorId);
    }

    return this.toSummary(updated);
  }

  /** A draft consumed no statutory number, so removing it leaves nothing inconsistent. */
  async remove(id: string, actorId: string): Promise<void> {
    const invoice = await this.load(id);
    this.assertDraft(invoice, 'deleted');

    await this.prisma.transaction(async (tx) => {
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.invoice.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'invoice.deleted',
        entityType: 'Invoice',
        entityId: id,
        before: { status: invoice.status, grandTotal: invoice.grandTotal.toFixed(4) },
        metadata: { actorId },
      });
    });
  }

  // ── Issue — the gate ──────────────────────────────────────────────────────

  /**
   * DRAFT → ISSUED. Allocates the statutory number and posts to the ledger.
   *
   * Six refusals, in the order of docs/23 §5.1. They are ordered by which one
   * will actually fire: the statutory gate is first because it is the one
   * blocking today, and a caller deserves the blocking reason rather than the
   * first of six.
   *
   * Everything happens in ONE transaction. A number allocated by a transaction
   * that then fails is returned (that is what `NumberSequenceService` buys),
   * and a ledger entry cannot exist for an invoice that was never issued.
   */
  async issue(id: string, invoiceDate: string | undefined, actorId: string) {
    const invoice = await this.loadForIssue(id);

    /*
     * Guarded on DRAFT explicitly, NOT via `canTransitionInvoice`.
     *
     * The transition table legitimately allows `PAID → ISSUED`: a credit note
     * that offsets everything paid leaves an invoice issued and unsettled
     * again, so the STATUS has to be able to travel back. But that is a
     * settlement movement, not permission to run the ISSUE action a second
     * time.
     *
     * Using the table here meant re-issuing a PAID invoice passed this check,
     * consumed a second statutory number, and then died on the immutability
     * trigger — surfacing as a 500 with a burnt number rather than a clean
     * refusal. Found by execution; a typecheck cannot see it, and the two
     * concepts read identically at the call site.
     */
    if (invoice.status !== 'DRAFT') {
      throw new ConflictError(
        `Invoice ${invoice.number ?? id} is ${invoice.status} and cannot be issued again. ` +
          'A statutory number is consumed exactly once.',
      );
    }

    await this.assertMayIssue(invoice, invoiceDate);

    const issueDate = invoiceDate ? new Date(`${invoiceDate}T00:00:00.000Z`) : invoice.invoiceDate;
    const dueDate = await this.dueDateFor(issueDate, invoice.paymentTermsCode);
    const supplyType = await this.classifySupply(invoice);
    const issuedAt = this.clock.now();

    const issued = await this.prisma.transaction(async (tx) => {
      const number = await this.sequences.next(tx, 'INVOICE');

      const result = await tx.invoice.update({
        where: { id },
        data: {
          status: 'ISSUED',
          number,
          invoiceDate: issueDate,
          dueDate,
          supplyType,
          issuedAt,
          issuedById: actorId,
        },
        select: INVOICE_SELECT,
      });

      // The ledger debit — written in the SAME transaction as the issue, so
      // there is no window in which the document exists and its effect does
      // not (ADR-0015 §5).
      await this.ledger.post(tx, {
        partyType: invoice.distributorId ? 'DISTRIBUTOR' : 'CUSTOMER',
        partyId: invoice.distributorId ?? invoice.customerId ?? '',
        entryType: 'INVOICE',
        debit: invoice.grandTotal.toFixed(4),
        refType: 'Invoice',
        refId: id,
        refNumber: number,
        entryDate: issueDate,
        narration: `Tax invoice ${number}`,
        actorId,
      });

      if (invoice.orderId) {
        await tx.orderTimeline.create({
          data: {
            orderId: invoice.orderId,
            event: 'INVOICED',
            description: `Invoice ${number} issued for ${Money.of(invoice.grandTotal.toFixed(4)).format()}`,
            metadata: { invoiceId: id, number },
            actorId,
          },
        });
      }

      await this.audit.record(tx, {
        action: 'invoice.issued',
        entityType: 'Invoice',
        entityId: id,
        after: {
          number,
          grandTotal: invoice.grandTotal.toFixed(4),
          supplyType,
          dueDate: dueDate?.toISOString().slice(0, 10) ?? null,
        },
        metadata: { actorId },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.INVOICE_ISSUED,
        { type: 'Invoice', id },
        {
          number,
          counterparty: invoice.counterpartyName,
          grandTotal: invoice.grandTotal.toFixed(4),
          dueDate: dueDate?.toISOString().slice(0, 10) ?? '',
        },
      );

      return result;
    });

    this.logger.info(
      { invoiceId: id, number: issued.number, grandTotal: issued.grandTotal.toFixed(4) },
      'Tax invoice issued',
    );

    return this.toSummary(issued);
  }

  /**
   * The six refusals.
   *
   * Separated from `issue()` so the gate is reviewable on its own. A control
   * buried in a workflow method is a control nobody reads — the same reasoning
   * that split `OrderApprovalService` out of `OrdersService` in Phase 7.
   */
  private async assertMayIssue(invoice: IssueCandidate, invoiceDate?: string): Promise<void> {
    // ── 1. The company's own statutory identity (open question E1) ─────────
    const statutory = await this.settings.companyStatutory();
    if (!statutory.verified || !statutory.gstin) {
      throw new InvoiceIssueRefusedError(
        'STATUTORY_IDENTITY_UNVERIFIED',
        'Cannot issue: the company’s GST registration has not been verified in this system. ' +
          'An invoice issued under an unconfirmed GSTIN is legally defective and cannot be ' +
          'withdrawn — only cancelled or credited. Set company.statutory.verified once the real ' +
          'GSTIN, PAN and CIN are in place.',
        { setting: 'company.statutory.verified' },
      );
    }
    if (!isValidGstin(statutory.gstin)) {
      throw new InvoiceIssueRefusedError(
        'STATUTORY_IDENTITY_UNVERIFIED',
        `Cannot issue: the company GSTIN on file (${statutory.gstin}) fails checksum validation.`,
        { setting: 'company.statutory.gstin' },
      );
    }

    // ── 2. A sell-out is not Hixaa's supply (ADR-0014 §6) ─────────────────
    if (invoice.order?.type === 'SECONDARY') {
      throw new InvoiceIssueRefusedError(
        'SECONDARY_ORDER_NOT_INVOICEABLE',
        `Cannot issue: order ${invoice.order.number} is a SECONDARY (sell-out) order — the ` +
          'distributor’s own sale to their customer. Hixaa’s GST liability ended at the sell-in ' +
          'invoice; billing it again would declare the same goods twice.',
        { orderNumber: invoice.order.number },
      );
    }

    // ── 5. Something to bill ──────────────────────────────────────────────
    if (invoice.lines.length === 0) {
      throw new InvoiceIssueRefusedError('EMPTY_INVOICE', 'Cannot issue an invoice with no lines.');
    }
    if (!Money.of(invoice.grandTotal.toFixed(4)).isPositive()) {
      throw new InvoiceIssueRefusedError(
        'EMPTY_INVOICE',
        'Cannot issue an invoice for zero. If nothing is payable, no tax invoice is due.',
      );
    }

    // ── 3. Every rate must be authoritative (ADR-0008) ────────────────────
    // Re-asked against the INVOICE's date rather than read from a stored flag:
    // the rate that matters legally is the one in force when the supply is
    // documented, and the order may have been priced weeks earlier.
    const asOf = invoiceDate
      ? new Date(`${invoiceDate}T00:00:00.000Z`)
      : invoice.invoiceDate;

    const unauthorised: string[] = [];
    for (const line of invoice.lines) {
      if (!line.hsnSacCode) {
        unauthorised.push(`${line.sku} (no HSN/SAC code)`);
        continue;
      }
      const rate = await this.pricing.resolveTaxRate(line.hsnSacCode, asOf);
      if (!rate) {
        unauthorised.push(`${line.sku} (HSN/SAC ${line.hsnSacCode})`);
      }
    }

    if (unauthorised.length > 0) {
      throw new InvoiceIssueRefusedError(
        'TAX_RATE_NOT_AUTHORITATIVE',
        'Cannot issue: no authoritative tax rate covers ' +
          `${unauthorised.join(', ')} on ${asOf.toISOString().slice(0, 10)}. ` +
          'These lines fell back to the product’s snapshot rate, which is acceptable for a ' +
          'quotation and not for a tax invoice. Add a TaxRate row covering the code.',
        { lines: unauthorised },
      );
    }

    // ── 4. A registered counterparty's GSTIN must be valid (Rule 46(f)) ───
    if (invoice.counterpartyGstin && !isValidGstin(invoice.counterpartyGstin)) {
      throw new InvoiceIssueRefusedError(
        'COUNTERPARTY_GSTIN_INVALID',
        `Cannot issue: ${invoice.counterpartyName}’s GSTIN (${invoice.counterpartyGstin}) fails ` +
          'checksum validation. The buyer cannot claim input credit against a malformed GSTIN.',
        { gstin: invoice.counterpartyGstin },
      );
    }

    // A future-dated tax invoice declares a supply that has not happened.
    const todayStr = this.today();
    const asOfStr = asOf.toISOString().slice(0, 10);
    if (asOfStr > todayStr) {
      throw new InvoiceIssueRefusedError(
        'FUTURE_DATED',
        `Cannot issue: ${asOfStr} is in the future. A tax invoice documents a supply that has ` +
          'already been made.',
        { invoiceDate: asOfStr },
      );
    }
  }

  // ── Cancel ────────────────────────────────────────────────────────────────

  /**
   * Narrow by design (docs/23 §5.2).
   *
   * The number is NOT released. A cancelled invoice keeps it and still appears
   * in GSTR-1 table 13 as cancelled — reusing it would create exactly the gap
   * the whole numbering design exists to prevent.
   */
  async cancel(id: string, reason: string, actorId: string) {
    const invoice = await this.load(id);

    if (invoice.status === 'DRAFT') {
      throw new ConflictError(
        'A draft invoice is deleted, not cancelled — it consumed no statutory number.',
      );
    }
    if (!canTransitionInvoice(invoice.status, 'CANCELLED')) {
      throw new ConflictError(
        `Invoice ${invoice.number} is ${invoice.status} and cannot be cancelled. ` +
          'Correct it with a credit note instead.',
      );
    }

    const [allocations, notes] = await Promise.all([
      this.prisma.db.paymentAllocation.count({ where: { invoiceId: id } }),
      this.prisma.db.taxNote.count({ where: { originalInvoiceId: id, status: 'ISSUED' } }),
    ]);

    if (allocations > 0) {
      throw new ConflictError(
        `Invoice ${invoice.number} has payments allocated against it. Un-allocate them first, ` +
          'or issue a credit note — cancelling a settled invoice would strand the receipt.',
      );
    }
    if (notes > 0) {
      throw new ConflictError(
        `Invoice ${invoice.number} already has ${notes} tax note(s) against it. It has been ` +
          'corrected rather than cancelled; issue a further note if more is needed.',
      );
    }

    // Same financial year. Cancelling across a year boundary would alter a
    // return that has already been filed.
    const issuedFy = this.financialYearOfDate(invoice.invoiceDate);
    const nowFy = this.financialYearOfDate(this.clock.now());
    if (issuedFy !== nowFy) {
      throw new ConflictError(
        `Invoice ${invoice.number} belongs to FY ${issuedFy} and it is now FY ${nowFy}. ` +
          'A prior year’s return has been filed — correct it with a credit note.',
      );
    }

    const cancelledAt = this.clock.now();

    const cancelled = await this.prisma.transaction(async (tx) => {
      const result = await tx.invoice.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt, cancelledById: actorId, cancelledReason: reason },
        select: INVOICE_SELECT,
      });

      // Contra the original debit rather than deleting it — the ledger is
      // append-only, and a cancelled invoice is a thing that happened.
      await this.ledger.post(tx, {
        partyType: invoice.distributorId ? 'DISTRIBUTOR' : 'CUSTOMER',
        partyId: invoice.distributorId ?? invoice.customerId ?? '',
        entryType: 'ADJUSTMENT',
        credit: invoice.grandTotal.toFixed(4),
        refType: 'Invoice',
        refId: id,
        refNumber: invoice.number,
        entryDate: cancelledAt,
        narration: `Invoice ${invoice.number} cancelled — ${reason}`,
        actorId,
      });

      await this.audit.record(tx, {
        action: 'invoice.cancelled',
        entityType: 'Invoice',
        entityId: id,
        before: { status: invoice.status },
        after: { status: 'CANCELLED', reason },
        metadata: { actorId, number: invoice.number },
      });

      return result;
    });

    this.logger.warn({ invoiceId: id, number: invoice.number, reason }, 'TAX INVOICE CANCELLED');
    return this.toSummary(cancelled);
  }

  // ── Settlement callbacks, used by PaymentsService and TaxNotesService ──────

  /**
   * Re-derives an invoice's settlement columns from the rows that cause them.
   *
   * Recomputed from allocations and notes rather than incremented in place: an
   * increment is a second source of truth that drifts the first time a path
   * forgets to call it, and this is cheap — both sets are small and indexed.
   *
   * `amountOutstanding` is not written here; the BEFORE trigger derives it.
   */
  async refreshSettlement(tx: PrismaTransaction, invoiceId: string): Promise<InvoiceStatus> {
    const [allocated, credited, invoice] = await Promise.all([
      tx.paymentAllocation.aggregate({ where: { invoiceId }, _sum: { amount: true } }),
      tx.taxNote.findMany({
        where: { originalInvoiceId: invoiceId, status: 'ISSUED' },
        select: { type: true, grandTotal: true },
      }),
      tx.invoice.findFirstOrThrow({
        where: { id: invoiceId },
        select: { grandTotal: true, status: true },
      }),
    ]);

    const amountPaid = Money.of(allocated._sum.amount?.toFixed(4) ?? '0');
    // Credit notes reduce what is owed; debit notes increase it. Signing the
    // sum keeps `outstanding = total − paid − credited` true for both without a
    // branch (ADR-0017 §4).
    const amountCredited = credited.reduce(
      (sum, note) =>
        note.type === 'CREDIT'
          ? sum.add(note.grandTotal.toFixed(4))
          : sum.subtract(note.grandTotal.toFixed(4)),
      Money.zero(),
    );

    const grandTotal = Money.of(invoice.grandTotal.toFixed(4));
    const settled = amountPaid.add(amountCredited);
    const status: InvoiceStatus =
      invoice.status === 'CANCELLED' || invoice.status === 'DRAFT'
        ? invoice.status
        : settled.gte(grandTotal)
          ? 'PAID'
          : settled.isPositive()
            ? 'PARTIALLY_PAID'
            : 'ISSUED';

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        amountPaid: amountPaid.toString(),
        amountCredited: amountCredited.toString(),
        status,
      },
    });

    return status;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private buildWhere(query: ListInvoicesQuery): Prisma.InvoiceWhereInput {
    const status = Array.isArray(query.status) ? query.status : query.status ? [query.status] : [];
    const today = this.today();

    return {
      ...(status.length ? { status: { in: status } } : {}),
      ...(query.distributorId ? { distributorId: query.distributorId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.supplyType ? { supplyType: query.supplyType } : {}),
      ...(query.outstandingOnly ? { amountOutstanding: { gt: 0 } } : {}),
      ...(query.overdueOnly
        ? {
            amountOutstanding: { gt: 0 },
            dueDate: { lt: new Date(`${today}T00:00:00.000Z`) },
            status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
          }
        : {}),
      ...(query.from || query.to
        ? {
            invoiceDate: {
              ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
              ...(query.to ? { lte: new Date(`${query.to}T00:00:00.000Z`) } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { number: { contains: query.q, mode: 'insensitive' } },
              { counterpartyName: { contains: query.q, mode: 'insensitive' } },
              { customerPoNumber: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  private toSummary(row: InvoiceRow) {
    const dueDate = row.dueDate ? row.dueDate.toISOString().slice(0, 10) : null;
    const amountOutstanding = row.amountOutstanding.toFixed(4);
    const overdue = isOverdue({ dueDate, amountOutstanding, status: row.status });

    return {
      id: row.id,
      number: row.number,
      status: row.status,
      supplyType: row.supplyType,
      isReverseCharge: row.isReverseCharge,
      distributorId: row.distributorId,
      distributorName: row.distributor?.legalName ?? null,
      customerId: row.customerId,
      customerName: row.customer?.name ?? null,
      orderId: row.orderId,
      orderNumber: row.order?.number ?? null,
      counterpartyName: row.counterpartyName,
      counterpartyGstin: row.counterpartyGstin,
      supplierStateCode: row.supplierStateCode,
      placeOfSupplyStateCode: row.placeOfSupplyStateCode,
      isInterState: GstCalculator.isInterState(
        row.supplierStateCode,
        row.placeOfSupplyStateCode,
      ),
      invoiceDate: row.invoiceDate.toISOString().slice(0, 10),
      dueDate,
      paymentTermsCode: row.paymentTermsCode,
      subtotal: row.subtotal.toFixed(4),
      totalDiscount: row.totalDiscount.toFixed(4),
      taxableValue: row.taxableValue.toFixed(4),
      totalCgst: row.totalCgst.toFixed(4),
      totalSgst: row.totalSgst.toFixed(4),
      totalIgst: row.totalIgst.toFixed(4),
      totalCess: row.totalCess.toFixed(4),
      totalTax: row.totalTax.toFixed(4),
      roundOff: row.roundOff.toFixed(4),
      grandTotal: row.grandTotal.toFixed(4),
      amountPaid: row.amountPaid.toFixed(4),
      amountCredited: row.amountCredited.toFixed(4),
      amountOutstanding,
      isOverdue: overdue,
      daysPastDue: overdue ? daysPastDue(dueDate) : 0,
      lineCount: row.lines.length,
      issuedAt: row.issuedAt,
      sentAt: row.sentAt,
      cancelledAt: row.cancelledAt,
      cancelledReason: row.cancelledReason,
      createdAt: row.createdAt,
    };
  }

  /** Writes the draft and its lines, computing document totals from the lines. */
  private async persistDraft(input: DraftInput) {
    const interState = GstCalculator.isInterState(
      input.supplierStateCode,
      input.placeOfSupplyStateCode,
    );

    // Document totals are the SUM of already-rounded line values (GstCalculator
    // §2). Computing them independently as sum(taxable) × rate disagrees with
    // the lines by a few paise, and the portal reads line-wise.
    const totals = GstCalculator.computeDocument(
      input.lines.map((line) => ({
        taxableValue: line.taxableValue,
        gstRate: line.gstRate,
        cgst: line.cgst,
        sgst: line.sgst,
        igst: line.igst,
        cess: line.cess,
        totalTax: line.totalTax,
        lineTotal: line.lineTotal,
      })),
    );

    const subtotal = Money.sum(
      input.lines.map((line) => Money.of(line.unitListPrice).multiply(line.quantity).toString()),
    );
    const totalDiscount = Money.sum(input.lines.map((line) => line.discountAmount));

    const counterparty = await this.loadCounterparty(input.distributorId, input.customerId);
    const dueDate = await this.dueDateFor(
      new Date(`${input.invoiceDate}T00:00:00.000Z`),
      input.paymentTermsCode,
    );

    const created = await this.prisma.transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          status: 'DRAFT',
          distributorId: input.distributorId,
          customerId: input.customerId,
          orderId: input.order?.id ?? null,
          supplierStateCode: input.supplierStateCode,
          placeOfSupplyStateCode: input.placeOfSupplyStateCode,
          // Classified properly at issue; a draft's is provisional and the
          // column is not nullable.
          supplyType: counterparty.gstin ? 'B2B' : 'B2CS',
          isReverseCharge: input.isReverseCharge,
          counterpartyName: counterparty.name,
          counterpartyGstin: counterparty.gstin,
          invoiceDate: new Date(`${input.invoiceDate}T00:00:00.000Z`),
          dueDate,
          paymentTermsCode: input.paymentTermsCode,
          customerPoNumber: input.customerPoNumber,
          customerPoDate: input.customerPoDate,
          subtotal: subtotal.toString(),
          totalDiscount: totalDiscount.toString(),
          taxableValue: totals.taxableValue,
          totalCgst: totals.totalCgst,
          totalSgst: totals.totalSgst,
          totalIgst: totals.totalIgst,
          totalCess: totals.totalCess,
          totalTax: totals.totalTax,
          roundOff: totals.roundOff,
          grandTotal: totals.grandTotal,
          notes: input.notes,
          termsAndConditions: input.termsAndConditions,
          createdById: input.actorId,
          lines: {
            createMany: {
              data: input.lines.map((line) => ({
                lineNumber: line.lineNumber,
                productId: line.productId,
                variantId: line.variantId,
                orderLineId: line.orderLineId,
                sku: line.sku,
                description: line.description,
                productRevision: line.productRevision,
                quantity: line.quantity,
                uomCode: line.uomCode,
                unitListPrice: line.unitListPrice,
                unitPrice: line.unitPrice,
                discountAmount: line.discountAmount,
                discountPercent: line.discountPercent,
                taxableValue: line.taxableValue,
                hsnSacCode: line.hsnSacCode,
                gstRate: line.gstRate,
                cessRate: line.cessRate,
                cgst: line.cgst,
                sgst: line.sgst,
                igst: line.igst,
                cess: line.cess,
                totalTax: line.totalTax,
                lineTotal: line.lineTotal,
                notes: line.notes,
              })),
            },
          },
        },
        select: INVOICE_SELECT,
      });

      await this.audit.record(tx, {
        action: 'invoice.drafted',
        entityType: 'Invoice',
        entityId: invoice.id,
        after: {
          orderNumber: input.order?.number ?? null,
          grandTotal: totals.grandTotal,
          lines: input.lines.length,
          interState,
        },
        metadata: { actorId: input.actorId },
      });

      return invoice;
    });

    return this.toSummary(created);
  }

  /** Re-derives every tax figure after the place of supply changed. */
  private async recomputeTax(id: string, actorId: string) {
    const invoice = await this.prisma.db.invoice.findFirstOrThrow({
      where: { id },
      select: {
        supplierStateCode: true,
        placeOfSupplyStateCode: true,
        lines: { select: { id: true, taxableValue: true, gstRate: true, cessRate: true } },
      },
    });

    const interState = GstCalculator.isInterState(
      invoice.supplierStateCode,
      invoice.placeOfSupplyStateCode,
    );

    const taxed = invoice.lines.map((line) => ({
      id: line.id,
      tax: GstCalculator.computeLine(
        {
          taxableValue: Money.of(line.taxableValue.toFixed(4)),
          gstRate: line.gstRate.toFixed(2),
          cessRate: line.cessRate.toFixed(2),
        },
        interState,
      ),
    }));

    const totals = GstCalculator.computeDocument(taxed.map((line) => line.tax));

    const updated = await this.prisma.transaction(async (tx) => {
      for (const line of taxed) {
        await tx.invoiceLine.update({
          where: { id: line.id },
          data: {
            cgst: line.tax.cgst,
            sgst: line.tax.sgst,
            igst: line.tax.igst,
            cess: line.tax.cess,
            totalTax: line.tax.totalTax,
            lineTotal: line.tax.lineTotal,
          },
        });
      }

      const result = await tx.invoice.update({
        where: { id },
        data: {
          taxableValue: totals.taxableValue,
          totalCgst: totals.totalCgst,
          totalSgst: totals.totalSgst,
          totalIgst: totals.totalIgst,
          totalCess: totals.totalCess,
          totalTax: totals.totalTax,
          roundOff: totals.roundOff,
          grandTotal: totals.grandTotal,
        },
        select: INVOICE_SELECT,
      });

      await this.audit.record(tx, {
        action: 'invoice.tax-recomputed',
        entityType: 'Invoice',
        entityId: id,
        after: { interState, grandTotal: totals.grandTotal },
        metadata: { actorId },
      });

      return result;
    });

    return this.toSummary(updated);
  }

  /**
   * How much of each order line previous invoices already carry.
   *
   * Cancelled invoices are excluded — their goods were never billed in a
   * surviving document, so the quantity is available again.
   */
  private async billedQuantitiesFor(orderId: string): Promise<Map<string, Money>> {
    const lines = await this.prisma.db.invoiceLine.findMany({
      where: {
        orderLineId: { not: null },
        invoice: { orderId, status: { not: 'CANCELLED' } },
      },
      select: { orderLineId: true, quantity: true },
    });

    const billed = new Map<string, Money>();
    for (const line of lines) {
      if (!line.orderLineId) continue;
      const current = billed.get(line.orderLineId) ?? Money.zero();
      billed.set(line.orderLineId, current.add(line.quantity.toFixed(4)));
    }
    return billed;
  }

  private orderLineToDraft(orderLine: OrderLineForBilling, quantity: Money): DraftLine {
    // Everything below is COPIED from the order line's snapshot (ADR-0011).
    // Only the quantity-dependent figures are recomputed, and they are
    // recomputed rather than prorated: prorating a rounded line total loses a
    // paisa per split, and the portal checks line arithmetic.
    const unitPrice = Money.of(orderLine.unitPrice.toFixed(4));
    const taxableValue = unitPrice.multiply(quantity.toString());
    const interState = Money.of(orderLine.igst.toFixed(4)).isPositive();

    const tax = GstCalculator.computeLine(
      {
        taxableValue,
        gstRate: orderLine.gstRate.toFixed(2),
        cessRate: '0',
      },
      interState,
    );

    const listPrice = Money.of(orderLine.unitListPrice.toFixed(4));
    const discountPerUnit = listPrice.subtract(unitPrice);

    return {
      // Overwritten by the caller, which numbers only the lines it keeps.
      lineNumber: 0,
      productId: orderLine.productId,
      variantId: orderLine.variantId,
      orderLineId: orderLine.id,
      sku: orderLine.sku,
      description: orderLine.description,
      productRevision: orderLine.productRevision,
      quantity: quantity.toString(),
      uomCode: orderLine.uomCode,
      unitListPrice: listPrice.toString(),
      unitPrice: unitPrice.toString(),
      discountAmount: discountPerUnit.multiply(quantity.toString()).toString(),
      discountPercent: orderLine.discountPercent.toFixed(4),
      taxableValue: tax.taxableValue,
      hsnSacCode: orderLine.hsnSacCode,
      gstRate: orderLine.gstRate.toFixed(2),
      cessRate: '0',
      cgst: tax.cgst,
      sgst: tax.sgst,
      igst: tax.igst,
      cess: tax.cess,
      totalTax: tax.totalTax,
      lineTotal: tax.lineTotal,
      notes: null,
    };
  }

  private async loadOrderForBilling(orderId: string) {
    const order = await this.prisma.db.order.findFirst({
      where: { id: orderId },
      select: {
        id: true,
        number: true,
        type: true,
        status: true,
        distributorId: true,
        customerId: true,
        placeOfSupplyStateCode: true,
        paymentTermsCode: true,
        customerPoNumber: true,
        customerPoDate: true,
        lines: {
          orderBy: { lineNumber: 'asc' },
          select: {
            id: true,
            lineNumber: true,
            productId: true,
            variantId: true,
            sku: true,
            description: true,
            productRevision: true,
            quantity: true,
            quantityDispatched: true,
            uomCode: true,
            unitListPrice: true,
            unitPrice: true,
            discountPercent: true,
            hsnSacCode: true,
            gstRate: true,
            igst: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundError('Order', orderId);

    // Refused at DRAFT rather than only at issue: billing an unapproved order
    // means billing figures nobody has agreed to.
    if (order.status === 'DRAFT' || order.status === 'PENDING_APPROVAL') {
      throw new ConflictError(
        `Order ${order.number} is ${order.status}. Only an approved order can be invoiced.`,
      );
    }
    if (order.status === 'CANCELLED' || order.status === 'REJECTED') {
      throw new ConflictError(`Order ${order.number} is ${order.status} and cannot be invoiced.`);
    }

    // The SECONDARY refusal also lives at issue, but failing here saves a user
    // from building a document they can never issue.
    if (order.type === 'SECONDARY') {
      throw new ConflictError(
        `Order ${order.number} is a SECONDARY (sell-out) order — the distributor’s own sale to ` +
          'their customer. Hixaa does not invoice it (ADR-0014 §6).',
      );
    }

    return order;
  }

  private async loadCounterparty(
    distributorId: string | null | undefined,
    customerId: string | null | undefined,
  ): Promise<{ name: string; gstin: string | null }> {
    if (distributorId) {
      const distributor = await this.prisma.db.distributor.findFirst({
        where: { id: distributorId },
        select: { legalName: true, gstin: true },
      });
      if (!distributor) throw new NotFoundError('Distributor', distributorId);
      return { name: distributor.legalName, gstin: distributor.gstin };
    }
    if (customerId) {
      const customer = await this.prisma.db.customer.findFirst({
        where: { id: customerId },
        select: { name: true, gstin: true },
      });
      if (!customer) throw new NotFoundError('Customer', customerId);
      return { name: customer.name, gstin: customer.gstin };
    }
    throw new ValidationError('An invoice must be addressed to a distributor or a customer');
  }

  /**
   * Classifies the supply for GSTR-1. Snapshotted at issue.
   *
   * The B2CL threshold is a SETTING rather than a constant: it moved from
   * ₹2.5 lakh to ₹1 lakh on 1 Nov 2024, and a statutory threshold that has
   * changed once will change again. A constant would need a deploy.
   */
  private async classifySupply(invoice: IssueCandidate): Promise<SupplyType> {
    const placeOfSupply = invoice.placeOfSupplyStateCode;

    if (placeOfSupply === '96' || placeOfSupply === '97') return 'EXPORT';
    if (invoice.counterpartyGstin) return 'B2B';

    const interState = GstCalculator.isInterState(invoice.supplierStateCode, placeOfSupply);
    if (!interState) return 'B2CS';

    const threshold = await this.b2clThreshold();
    return Money.of(invoice.grandTotal.toFixed(4)).gt(threshold) ? 'B2CL' : 'B2CS';
  }

  private async b2clThreshold(): Promise<string> {
    const gst = await this.settings.get<{ b2clThreshold?: string | number }>('finance', 'gst');
    const configured = gst?.b2clThreshold;
    return configured === undefined || configured === null ? '100000' : String(configured);
  }

  /**
   * Due date from the payment terms, snapshotted at issue.
   *
   * Terms are editable settings; an invoice's due date is printed on a document
   * and is not. Reading the term at issue and storing the resulting date is
   * what keeps the two from disagreeing later.
   */
  private async dueDateFor(invoiceDate: Date, termsCode: string | null): Promise<Date | null> {
    if (!termsCode) return null;

    const terms = await this.settings.get<Array<{ code: string; days: number }>>(
      'finance',
      'paymentTerms',
    );
    const term = terms?.find((t) => t.code === termsCode);
    if (!term) {
      this.logger.warn(
        { termsCode },
        'Payment terms code not found in settings — invoice issued without a due date',
      );
      return null;
    }

    const due = new Date(invoiceDate);
    due.setUTCDate(due.getUTCDate() + term.days);
    return due;
  }

  private async supplierStateCode(): Promise<string> {
    const statutory = await this.settings.get<{ stateCode?: string }>('company', 'statutory');
    const code = statutory?.stateCode?.trim();
    if (code && code in GST_STATE_CODES) return code;
    return '27';
  }

  private async load(id: string) {
    const invoice = await this.prisma.db.invoice.findFirst({
      where: { id },
      select: {
        id: true,
        number: true,
        status: true,
        distributorId: true,
        customerId: true,
        grandTotal: true,
        invoiceDate: true,
        placeOfSupplyStateCode: true,
      },
    });
    if (!invoice) throw new NotFoundError('Invoice', id);
    return invoice;
  }

  private async loadForIssue(id: string) {
    const invoice = await this.prisma.db.invoice.findFirst({
      where: { id },
      select: {
        id: true,
        number: true,
        status: true,
        distributorId: true,
        customerId: true,
        orderId: true,
        counterpartyName: true,
        counterpartyGstin: true,
        supplierStateCode: true,
        placeOfSupplyStateCode: true,
        invoiceDate: true,
        paymentTermsCode: true,
        grandTotal: true,
        order: { select: { number: true, type: true } },
        lines: { select: { sku: true, hsnSacCode: true } },
      },
    });
    if (!invoice) throw new NotFoundError('Invoice', id);
    return invoice;
  }

  private assertDraft(
    invoice: { status: InvoiceStatus; number: string | null },
    verb: string,
  ): void {
    if (invoice.status !== 'DRAFT') {
      throw new ImmutableRecordError(
        'Invoice',
        `${invoice.number ?? 'this invoice'} is ${invoice.status} and cannot be ${verb}. ` +
          'An issued tax invoice is corrected by a credit or debit note (CGST s.34), never edited.',
      );
    }
  }

  private today(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }

  /** Local rather than imported: `financialYearOf` takes a Date and this reads better here. */
  private financialYearOfDate(date: Date): string {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const startYear = month >= 4 ? year : year - 1;
    return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  }
}

// ── Internal shapes ─────────────────────────────────────────────────────────

interface DraftLine {
  lineNumber: number;
  productId: string;
  variantId: string | null;
  orderLineId: string | null;
  sku: string;
  description: string;
  productRevision: number;
  quantity: string;
  uomCode: string | null;
  unitListPrice: string;
  unitPrice: string;
  discountAmount: string;
  discountPercent: string;
  taxableValue: string;
  hsnSacCode: string | null;
  gstRate: string;
  cessRate: string;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
  totalTax: string;
  lineTotal: string;
  notes: string | null;
}

interface DraftInput {
  order: { id: string; number: string } | null;
  distributorId: string | null;
  customerId: string | null;
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  invoiceDate: string;
  paymentTermsCode: string | null;
  customerPoNumber: string | null;
  customerPoDate: Date | null;
  isReverseCharge: boolean;
  lines: DraftLine[];
  notes: string | null;
  termsAndConditions: string | null;
  actorId: string;
}

type OrderLineForBilling = Awaited<
  ReturnType<InvoicesService['loadOrderForBilling']>
>['lines'][number];

type IssueCandidate = Awaited<ReturnType<InvoicesService['loadForIssue']>>;
