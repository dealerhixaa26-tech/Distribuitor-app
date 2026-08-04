import { Injectable } from '@nestjs/common';
import {
  Money,
  type CreateTaxNoteDto,
  type ListTaxNotesQuery,
  type TaxNoteType,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import {
  ConflictError,
  ImmutableRecordError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain.error';
import { keysetWhere, toListResult } from '../../common/utils/pagination.util';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { NumberSequenceService } from '../distributors/number-sequence.service';
import { GstCalculator } from '../pricing/gst-calculator';
import { SettingsService } from '../settings/settings.service';
import { InvoicesService } from './invoices.service';
import { LedgerService } from './ledger.service';

/**
 * Credit and debit notes — the only lawful way to correct an issued invoice
 * (CGST s.34). See ADR-0017.
 *
 * ── One service, two document types ────────────────────────────────────────
 * Every method takes `type` as a REQUIRED argument rather than an optional
 * filter, so a query cannot accidentally return both. The type is fixed by the
 * route (`/credit-notes` vs `/debit-notes`), never accepted in a body — a
 * client must not be able to choose which gapless series it consumes.
 *
 * The sign lives in exactly one expression, in `postToLedger`. Everything else
 * — tax computation, totals, the GSTR-1 9B mapping — is type-agnostic and so
 * cannot be right for one type and wrong for the other.
 */
const NOTE_SELECT = {
  id: true,
  type: true,
  number: true,
  status: true,
  originalInvoiceId: true,
  reason: true,
  reasonNote: true,
  counterpartyName: true,
  counterpartyGstin: true,
  supplierStateCode: true,
  placeOfSupplyStateCode: true,
  noteDate: true,
  taxableValue: true,
  totalCgst: true,
  totalSgst: true,
  totalIgst: true,
  totalCess: true,
  totalTax: true,
  roundOff: true,
  grandTotal: true,
  issuedAt: true,
  createdAt: true,
  originalInvoice: { select: { number: true } },
  lines: { select: { id: true } },
} satisfies Prisma.TaxNoteSelect;

type NoteRow = Prisma.TaxNoteGetPayload<{ select: typeof NOTE_SELECT }>;

@Injectable()
export class TaxNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly sequences: NumberSequenceService,
    private readonly audit: AuditService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TaxNotesService.name);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(type: TaxNoteType, query: ListTaxNotesQuery) {
    const where: Prisma.TaxNoteWhereInput = {
      type,
      ...(query.status ? { status: query.status } : {}),
      ...(query.originalInvoiceId ? { originalInvoiceId: query.originalInvoiceId } : {}),
      ...(query.distributorId || query.customerId
        ? {
            originalInvoice: {
              ...(query.distributorId ? { distributorId: query.distributorId } : {}),
              ...(query.customerId ? { customerId: query.customerId } : {}),
            },
          }
        : {}),
      ...(query.from || query.to
        ? {
            noteDate: {
              ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
              ...(query.to ? { lte: new Date(`${query.to}T00:00:00.000Z`) } : {}),
            },
          }
        : {}),
    };

    const cursorWhere = keysetWhere(query.cursor);
    const rows = await this.prisma.db.taxNote.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: NOTE_SELECT,
    });

    const totalCount = query.includeTotal
      ? await this.prisma.db.taxNote.count({ where })
      : undefined;

    const result = toListResult(rows, query.limit, totalCount);
    return { ...result, data: result.data.map(toSummary) };
  }

  async findDetail(type: TaxNoteType, id: string) {
    const note = await this.prisma.db.taxNote.findFirst({
      where: { id, type },
      select: NOTE_SELECT,
    });
    if (!note) throw new NotFoundError(this.label(type), id);

    const lines = await this.prisma.db.taxNoteLine.findMany({
      where: { taxNoteId: id },
      orderBy: { lineNumber: 'asc' },
    });

    return {
      ...toSummary(note),
      lines: lines.map((line) => ({
        id: line.id,
        lineNumber: line.lineNumber,
        invoiceLineId: line.invoiceLineId,
        productId: line.productId,
        sku: line.sku,
        description: line.description,
        quantity: line.quantity?.toFixed(4) ?? null,
        uomCode: line.uomCode,
        unitPrice: line.unitPrice?.toFixed(4) ?? null,
        taxableValue: line.taxableValue.toFixed(4),
        hsnSacCode: line.hsnSacCode,
        gstRate: line.gstRate.toFixed(2),
        cgst: line.cgst.toFixed(4),
        sgst: line.sgst.toFixed(4),
        igst: line.igst.toFixed(4),
        cess: line.cess.toFixed(4),
        totalTax: line.totalTax.toFixed(4),
        lineTotal: line.lineTotal.toFixed(4),
      })),
    };
  }

  // ── Draft ─────────────────────────────────────────────────────────────────

  /**
   * Drafts a note against an issued invoice.
   *
   * Each line's tax rate is COPIED from the invoice line it corrects, never
   * resolved afresh. A note taxed at today's rate against an invoice taxed at
   * last year's is a mismatch the portal rejects — and the rate that applies to
   * a correction is the rate that applied to the supply.
   */
  async create(type: TaxNoteType, dto: CreateTaxNoteDto, actorId: string) {
    const invoice = await this.loadInvoiceForCorrection(dto.originalInvoiceId);
    const noteDate = dto.noteDate ?? this.today();

    const interState = GstCalculator.isInterState(
      invoice.supplierStateCode,
      invoice.placeOfSupplyStateCode,
    );

    const invoiceLines = new Map(invoice.lines.map((line) => [line.id, line]));

    const taxed = dto.lines.map((line, index) => {
      const source = line.invoiceLineId ? invoiceLines.get(line.invoiceLineId) : undefined;
      if (line.invoiceLineId && !source) {
        throw new NotFoundError('Invoice line', line.invoiceLineId);
      }

      // A document-level note (no line reference) carries the invoice's
      // predominant rate. Falling back to zero would understate the tax
      // adjustment; falling back to today's table would use a rate that never
      // applied to this supply.
      const gstRate = source
        ? source.gstRate.toFixed(2)
        : this.predominantRate(invoice.lines).toFixed(2);
      const cessRate = source ? source.cessRate.toFixed(2) : '0';

      const tax = GstCalculator.computeLine(
        { taxableValue: Money.of(line.taxableValue), gstRate, cessRate },
        interState,
      );

      return {
        lineNumber: index + 1,
        invoiceLineId: line.invoiceLineId ?? null,
        productId: source?.productId ?? null,
        sku: source?.sku ?? null,
        description: line.description,
        quantity: line.quantity ?? null,
        uomCode: source?.uomCode ?? null,
        unitPrice: source?.unitPrice.toFixed(4) ?? null,
        taxableValue: tax.taxableValue,
        hsnSacCode: source?.hsnSacCode ?? null,
        gstRate,
        cessRate,
        cgst: tax.cgst,
        sgst: tax.sgst,
        igst: tax.igst,
        cess: tax.cess,
        totalTax: tax.totalTax,
        lineTotal: tax.lineTotal,
        tax,
      };
    });

    const totals = GstCalculator.computeDocument(taxed.map((line) => line.tax));

    await this.assertWithinInvoice(type, invoice, Money.of(totals.grandTotal));

    const created = await this.prisma.transaction(async (tx) => {
      const note = await tx.taxNote.create({
        data: {
          type,
          status: 'DRAFT',
          originalInvoiceId: invoice.id,
          reason: dto.reason,
          reasonNote: dto.reasonNote ?? null,
          supplierStateCode: invoice.supplierStateCode,
          placeOfSupplyStateCode: invoice.placeOfSupplyStateCode,
          counterpartyName: invoice.counterpartyName,
          counterpartyGstin: invoice.counterpartyGstin,
          noteDate: new Date(`${noteDate}T00:00:00.000Z`),
          taxableValue: totals.taxableValue,
          totalCgst: totals.totalCgst,
          totalSgst: totals.totalSgst,
          totalIgst: totals.totalIgst,
          totalCess: totals.totalCess,
          totalTax: totals.totalTax,
          roundOff: totals.roundOff,
          grandTotal: totals.grandTotal,
          createdById: actorId,
          lines: {
            createMany: {
              data: taxed.map((line) => ({
                lineNumber: line.lineNumber,
                invoiceLineId: line.invoiceLineId,
                productId: line.productId,
                sku: line.sku,
                description: line.description,
                quantity: line.quantity,
                uomCode: line.uomCode,
                unitPrice: line.unitPrice,
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
              })),
            },
          },
        },
        select: NOTE_SELECT,
      });

      await this.audit.record(tx, {
        action: `taxnote.drafted`,
        entityType: 'TaxNote',
        entityId: note.id,
        after: {
          type,
          invoiceNumber: invoice.number,
          grandTotal: totals.grandTotal,
          reason: dto.reason,
        },
        metadata: { actorId },
      });

      return note;
    });

    return toSummary(created);
  }

  // ── Issue ─────────────────────────────────────────────────────────────────

  /**
   * DRAFT → ISSUED. Allocates the series number and posts to the ledger.
   *
   * The invoice's settlement is refreshed in the same transaction, so
   * `amountCredited` and `amountOutstanding` move with the note rather than
   * behind it.
   */
  async issue(type: TaxNoteType, id: string, noteDate: string | undefined, actorId: string) {
    const note = await this.prisma.db.taxNote.findFirst({
      where: { id, type },
      select: {
        id: true,
        type: true,
        number: true,
        status: true,
        grandTotal: true,
        noteDate: true,
        originalInvoiceId: true,
        originalInvoice: {
          select: {
            id: true,
            number: true,
            status: true,
            distributorId: true,
            customerId: true,
          },
        },
        lines: { select: { id: true } },
      },
    });
    if (!note) throw new NotFoundError(this.label(type), id);

    if (note.status !== 'DRAFT') {
      throw new ConflictError(
        `${this.label(type)} ${note.number} is ${note.status} and cannot be issued again.`,
      );
    }
    if (note.lines.length === 0) {
      throw new ValidationError(`Cannot issue a ${this.label(type).toLowerCase()} with no lines.`);
    }

    // The company's own statutory identity gates a note exactly as it gates an
    // invoice — a note is a tax document with its own number and its own place
    // in the return.
    const statutory = await this.settings.companyStatutory();
    if (!statutory.verified || !statutory.gstin) {
      throw new ValidationError(
        `Cannot issue: the company’s GST registration has not been verified. A ` +
          `${this.label(type).toLowerCase()} is a statutory document under CGST s.34 and carries ` +
          'the same requirement as the invoice it corrects.',
      );
    }

    const issueDate = noteDate ? new Date(`${noteDate}T00:00:00.000Z`) : note.noteDate;
    const sequenceKey = type === 'CREDIT' ? 'CREDIT_NOTE' : 'DEBIT_NOTE';
    const issuedAt = this.clock.now();
    const partyType = note.originalInvoice.distributorId ? 'DISTRIBUTOR' : 'CUSTOMER';
    const partyId =
      note.originalInvoice.distributorId ?? note.originalInvoice.customerId ?? '';

    const issued = await this.prisma.transaction(async (tx) => {
      const number = await this.sequences.next(tx, sequenceKey);

      const result = await tx.taxNote.update({
        where: { id },
        data: {
          status: 'ISSUED',
          number,
          noteDate: issueDate,
          issuedAt,
          issuedById: actorId,
        },
        select: NOTE_SELECT,
      });

      // THE one place the sign lives (ADR-0017 §4). A credit note credits the
      // party (they owe less); a debit note debits them.
      const amount = note.grandTotal.toFixed(4);
      await this.ledger.post(tx, {
        partyType,
        partyId,
        entryType: type === 'CREDIT' ? 'CREDIT_NOTE' : 'DEBIT_NOTE',
        ...(type === 'CREDIT' ? { credit: amount } : { debit: amount }),
        refType: 'TaxNote',
        refId: id,
        refNumber: number,
        entryDate: issueDate,
        narration: `${this.label(type)} ${number} against invoice ${note.originalInvoice.number}`,
        actorId,
      });

      await this.invoices.refreshSettlement(tx, note.originalInvoiceId);

      await this.audit.record(tx, {
        action: 'taxnote.issued',
        entityType: 'TaxNote',
        entityId: id,
        after: {
          type,
          number,
          grandTotal: amount,
          invoiceNumber: note.originalInvoice.number,
        },
        metadata: { actorId },
      });

      return result;
    });

    this.logger.info(
      { noteId: id, type, number: issued.number, grandTotal: issued.grandTotal.toFixed(4) },
      `${this.label(type)} issued`,
    );

    return toSummary(issued);
  }

  async remove(type: TaxNoteType, id: string, actorId: string): Promise<void> {
    const note = await this.prisma.db.taxNote.findFirst({
      where: { id, type },
      select: { id: true, status: true, number: true },
    });
    if (!note) throw new NotFoundError(this.label(type), id);

    if (note.status !== 'DRAFT') {
      throw new ImmutableRecordError(
        this.label(type).toLowerCase(),
        `${note.number} is ${note.status}. Issue a further note rather than removing this one — ` +
          'its number is part of a statutory series.',
      );
    }

    await this.prisma.transaction(async (tx) => {
      await tx.taxNoteLine.deleteMany({ where: { taxNoteId: id } });
      await tx.taxNote.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'taxnote.deleted',
        entityType: 'TaxNote',
        entityId: id,
        before: { type, status: note.status },
        metadata: { actorId },
      });
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * A note may not take an invoice past what remains on it.
   *
   * Crediting more than was invoiced is not a correction — it is a discount
   * that should have been on the invoice, and it would leave a credit balance
   * the invoice's own columns cannot express. Backed by
   * `invoice_not_over_settled` (ADR-0015 §4) if this is ever bypassed.
   */
  private async assertWithinInvoice(
    type: TaxNoteType,
    invoice: { id: string; number: string | null; grandTotal: Prisma.Decimal },
    noteTotal: Money,
  ): Promise<void> {
    if (type !== 'CREDIT') return;

    const [allocated, existing] = await Promise.all([
      this.prisma.db.paymentAllocation.aggregate({
        where: { invoiceId: invoice.id },
        _sum: { amount: true },
      }),
      this.prisma.db.taxNote.findMany({
        where: { originalInvoiceId: invoice.id, status: 'ISSUED' },
        select: { type: true, grandTotal: true },
      }),
    ]);

    const paid = Money.of(allocated._sum.amount?.toFixed(4) ?? '0');
    const credited = existing.reduce(
      (sum, note) =>
        note.type === 'CREDIT'
          ? sum.add(note.grandTotal.toFixed(4))
          : sum.subtract(note.grandTotal.toFixed(4)),
      Money.zero(),
    );

    const headroom = Money.of(invoice.grandTotal.toFixed(4)).subtract(paid).subtract(credited);

    if (noteTotal.gt(headroom)) {
      throw new ValidationError(
        `A credit note for ${noteTotal.format()} exceeds what remains on invoice ` +
          `${invoice.number}: ${headroom.format()} (total ` +
          `${Money.of(invoice.grandTotal.toFixed(4)).format()}, paid ${paid.format()}, already ` +
          `credited ${credited.format()}).`,
      );
    }
  }

  private async loadInvoiceForCorrection(invoiceId: string) {
    const invoice = await this.prisma.db.invoice.findFirst({
      where: { id: invoiceId },
      select: {
        id: true,
        number: true,
        status: true,
        grandTotal: true,
        supplierStateCode: true,
        placeOfSupplyStateCode: true,
        counterpartyName: true,
        counterpartyGstin: true,
        distributorId: true,
        customerId: true,
        lines: {
          select: {
            id: true,
            productId: true,
            sku: true,
            uomCode: true,
            unitPrice: true,
            taxableValue: true,
            hsnSacCode: true,
            gstRate: true,
            cessRate: true,
          },
        },
      },
    });
    if (!invoice) throw new NotFoundError('Invoice', invoiceId);

    if (invoice.status === 'DRAFT') {
      throw new ConflictError(
        'A draft invoice is edited directly — a tax note corrects an ISSUED invoice.',
      );
    }
    if (invoice.status === 'CANCELLED') {
      throw new ConflictError(
        `Invoice ${invoice.number} is cancelled. There is nothing left to correct.`,
      );
    }

    return invoice;
  }

  /** The rate carrying the most taxable value on the invoice. */
  private predominantRate(
    lines: ReadonlyArray<{ gstRate: Prisma.Decimal; taxableValue: Prisma.Decimal }>,
  ): Prisma.Decimal {
    let best = lines[0]?.gstRate;
    let bestValue = Money.zero();

    const byRate = new Map<string, Money>();
    for (const line of lines) {
      const key = line.gstRate.toFixed(2);
      byRate.set(
        key,
        (byRate.get(key) ?? Money.zero()).add(line.taxableValue.toFixed(4)),
      );
    }

    for (const line of lines) {
      const value = byRate.get(line.gstRate.toFixed(2)) ?? Money.zero();
      if (value.gt(bestValue)) {
        bestValue = value;
        best = line.gstRate;
      }
    }

    if (!best) {
      throw new ValidationError(
        'Cannot draft a document-level note against an invoice with no lines — there is no rate ' +
          'to apply.',
      );
    }
    return best;
  }

  private label(type: TaxNoteType): string {
    return type === 'CREDIT' ? 'Credit note' : 'Debit note';
  }

  private today(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }
}

function toSummary(row: NoteRow) {
  return {
    id: row.id,
    type: row.type,
    number: row.number,
    status: row.status,
    originalInvoiceId: row.originalInvoiceId,
    originalInvoiceNumber: row.originalInvoice?.number ?? null,
    reason: row.reason,
    reasonNote: row.reasonNote,
    counterpartyName: row.counterpartyName,
    counterpartyGstin: row.counterpartyGstin,
    placeOfSupplyStateCode: row.placeOfSupplyStateCode,
    noteDate: row.noteDate.toISOString().slice(0, 10),
    taxableValue: row.taxableValue.toFixed(4),
    totalCgst: row.totalCgst.toFixed(4),
    totalSgst: row.totalSgst.toFixed(4),
    totalIgst: row.totalIgst.toFixed(4),
    totalCess: row.totalCess.toFixed(4),
    totalTax: row.totalTax.toFixed(4),
    roundOff: row.roundOff.toFixed(4),
    grandTotal: row.grandTotal.toFixed(4),
    lineCount: row.lines.length,
    issuedAt: row.issuedAt,
    createdAt: row.createdAt,
  };
}
