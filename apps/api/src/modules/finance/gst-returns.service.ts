import { Injectable } from '@nestjs/common';
import { Money, toReturnPeriod, type GstReturnQuery } from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ValidationError } from '../../common/errors/domain.error';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { GstCalculator } from '../pricing/gst-calculator';
import { SettingsService } from '../settings/settings.service';

/**
 * GSTR-1 and GSTR-3B extraction.
 *
 * ── Read-only, and deliberately not a filing integration ───────────────────
 * This produces the portal's own JSON shape for a period. Nothing here talks to
 * the GSTN. A CA uploads it, or feeds it to an offline utility, and remains the
 * person accountable for the return — which is the correct division of
 * responsibility for a system that has been issuing invoices for a few weeks.
 *
 * ── The exclusion that runs through everything ─────────────────────────────
 * `type = 'SECONDARY'` orders never appear. A sell-out is the distributor's
 * supply to their own customer; Hixaa's liability ended at the sell-in invoice
 * (ADR-0014 §6, obligation from docs/22 §7). Enforced HERE at the query and
 * separately at issue, so neither one alone is load-bearing — and the summary
 * reports how many were excluded, because a silent exclusion is indistinguishable
 * from a missing row.
 *
 * ── Money crosses into this file as strings and leaves as numbers ──────────
 * The portal's schema is numeric, so the boundary conversion happens once, here,
 * at the very end. Every intermediate is `Money` (ADR-0004). Doing it the other
 * way — parsing to float early and formatting late — is how a return ends up
 * disagreeing with the invoices behind it by a few paise per line.
 */
@Injectable()
export class GstReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GstReturnsService.name);
  }

  async gstr1(query: GstReturnQuery) {
    const { from, to } = this.range(query);
    const statutory = await this.settings.companyStatutory();

    const invoices = await this.prisma.db.invoice.findMany({
      where: this.periodWhere(from, to),
      orderBy: { invoiceDate: 'asc' },
      select: {
        id: true,
        number: true,
        status: true,
        invoiceDate: true,
        supplyType: true,
        isReverseCharge: true,
        counterpartyGstin: true,
        placeOfSupplyStateCode: true,
        supplierStateCode: true,
        grandTotal: true,
        lines: {
          select: {
            taxableValue: true,
            gstRate: true,
            cgst: true,
            sgst: true,
            igst: true,
            cess: true,
            hsnSacCode: true,
            description: true,
            quantity: true,
            uomCode: true,
          },
        },
      },
    });

    const excludedSecondary = await this.prisma.db.invoice.count({
      where: {
        invoiceDate: { gte: from, lte: to },
        status: { not: 'DRAFT' },
        order: { type: 'SECONDARY' },
      },
    });
    if (excludedSecondary > 0) {
      this.logger.warn(
        { excludedSecondary, from, to },
        'Invoices derived from SECONDARY orders excluded from GSTR-1 — this should be zero, ' +
          'because issuing one is refused',
      );
    }

    const live = invoices.filter((invoice) => invoice.status !== 'CANCELLED');

    const notes = await this.prisma.db.taxNote.findMany({
      where: {
        noteDate: { gte: from, lte: to },
        status: 'ISSUED',
        originalInvoice: { OR: [{ orderId: null }, { order: { type: 'PRIMARY' } }] },
      },
      orderBy: { noteDate: 'asc' },
      select: {
        type: true,
        number: true,
        noteDate: true,
        counterpartyGstin: true,
        placeOfSupplyStateCode: true,
        grandTotal: true,
        originalInvoice: { select: { number: true, invoiceDate: true } },
        lines: {
          select: {
            taxableValue: true,
            gstRate: true,
            cgst: true,
            sgst: true,
            igst: true,
            cess: true,
          },
        },
      },
    });

    return {
      gstin: statutory.gstin,
      fp: toReturnPeriod(from.toISOString().slice(0, 10)),
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      b2b: this.buildB2b(live),
      b2cl: this.buildB2cl(live),
      b2cs: this.buildB2cs(live),
      cdnr: this.buildCdnr(notes),
      hsn: { data: this.buildHsn(live) },
      doc_issue: { doc_det: this.buildDocsIssued(invoices, notes) },
      summary: this.buildSummary(invoices, notes, excludedSecondary),
    };
  }

  async gstr3b(query: GstReturnQuery) {
    const { from, to } = this.range(query);
    const statutory = await this.settings.companyStatutory();

    const invoices = await this.prisma.db.invoice.findMany({
      where: { ...this.periodWhere(from, to), status: { not: 'CANCELLED' } },
      select: {
        supplyType: true,
        placeOfSupplyStateCode: true,
        supplierStateCode: true,
        counterpartyGstin: true,
        taxableValue: true,
        totalCgst: true,
        totalSgst: true,
        totalIgst: true,
        totalCess: true,
      },
    });

    const notes = await this.prisma.db.taxNote.findMany({
      where: {
        noteDate: { gte: from, lte: to },
        status: 'ISSUED',
        originalInvoice: { OR: [{ orderId: null }, { order: { type: 'PRIMARY' } }] },
      },
      select: {
        type: true,
        taxableValue: true,
        totalCgst: true,
        totalSgst: true,
        totalIgst: true,
        totalCess: true,
      },
    });

    // 3.1(a) is NET of credit and debit notes — the return declares the period's
    // actual outward liability, not its gross invoicing.
    let taxable = Money.zero();
    let cgst = Money.zero();
    let sgst = Money.zero();
    let igst = Money.zero();
    let cess = Money.zero();

    for (const invoice of invoices) {
      taxable = taxable.add(invoice.taxableValue.toFixed(4));
      cgst = cgst.add(invoice.totalCgst.toFixed(4));
      sgst = sgst.add(invoice.totalSgst.toFixed(4));
      igst = igst.add(invoice.totalIgst.toFixed(4));
      cess = cess.add(invoice.totalCess.toFixed(4));
    }

    let creditNoteCount = 0;
    let debitNoteCount = 0;
    for (const note of notes) {
      const sign = note.type === 'CREDIT' ? -1 : 1;
      if (note.type === 'CREDIT') creditNoteCount += 1;
      else debitNoteCount += 1;

      const apply = (base: Money, value: Prisma.Decimal): Money =>
        sign === -1 ? base.subtract(value.toFixed(4)) : base.add(value.toFixed(4));

      taxable = apply(taxable, note.taxableValue);
      cgst = apply(cgst, note.totalCgst);
      sgst = apply(sgst, note.totalSgst);
      igst = apply(igst, note.totalIgst);
      cess = apply(cess, note.totalCess);
    }

    // 3.2 — inter-state supplies to UNREGISTERED persons, by place of supply.
    const unregistered = new Map<string, { txval: Money; iamt: Money }>();
    for (const invoice of invoices) {
      if (invoice.counterpartyGstin) continue;
      if (!GstCalculator.isInterState(invoice.supplierStateCode, invoice.placeOfSupplyStateCode)) {
        continue;
      }
      const key = invoice.placeOfSupplyStateCode;
      const bucket = unregistered.get(key) ?? { txval: Money.zero(), iamt: Money.zero() };
      bucket.txval = bucket.txval.add(invoice.taxableValue.toFixed(4));
      bucket.iamt = bucket.iamt.add(invoice.totalIgst.toFixed(4));
      unregistered.set(key, bucket);
    }

    const netTax = cgst.add(sgst).add(igst).add(cess);

    return {
      gstin: statutory.gstin,
      ret_period: toReturnPeriod(from.toISOString().slice(0, 10)),
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      sup_details: {
        osup_det: {
          txval: num(taxable),
          iamt: num(igst),
          camt: num(cgst),
          samt: num(sgst),
          csamt: num(cess),
        },
        osup_zero: { txval: 0, iamt: 0, csamt: 0 },
        osup_nil_exmp: { txval: 0 },
      },
      inter_sup: {
        unreg_details: [...unregistered.entries()].map(([pos, value]) => ({
          pos,
          txval: num(value.txval),
          iamt: num(value.iamt),
        })),
      },
      itc_elg: {
        itc_avl: [],
        // Stated rather than omitted: an absent ITC section reads as "nothing to
        // claim", which for most businesses is wrong and expensive.
        note:
          'Input tax credit is not computed. This system holds no purchase documents — ' +
          'GSTR-2B reconciliation is out of scope until a purchase module exists. Table 4 must ' +
          'be completed from your purchase records before filing.',
      },
      summary: {
        invoiceCount: invoices.length,
        creditNoteCount,
        debitNoteCount,
        netTaxableValue: taxable.toString(),
        netTaxPayable: netTax.toString(),
      },
    };
  }

  // ── GSTR-1 sections ───────────────────────────────────────────────────────

  private buildB2b(invoices: readonly InvoiceForReturn[]) {
    const byGstin = new Map<string, InvoiceForReturn[]>();
    for (const invoice of invoices) {
      if (invoice.supplyType !== 'B2B' || !invoice.counterpartyGstin) continue;
      const bucket = byGstin.get(invoice.counterpartyGstin) ?? [];
      bucket.push(invoice);
      byGstin.set(invoice.counterpartyGstin, bucket);
    }

    return [...byGstin.entries()].map(([ctin, group]) => ({
      ctin,
      inv: group.map((invoice) => ({
        inum: invoice.number ?? '',
        idt: this.portalDate(invoice.invoiceDate),
        val: num(Money.of(invoice.grandTotal.toFixed(4))),
        pos: invoice.placeOfSupplyStateCode,
        rchrg: invoice.isReverseCharge ? ('Y' as const) : ('N' as const),
        inv_typ: 'R',
        itms: this.rateWiseItems(invoice.lines),
      })),
    }));
  }

  private buildB2cl(invoices: readonly InvoiceForReturn[]) {
    const byPos = new Map<string, InvoiceForReturn[]>();
    for (const invoice of invoices) {
      if (invoice.supplyType !== 'B2CL') continue;
      const bucket = byPos.get(invoice.placeOfSupplyStateCode) ?? [];
      bucket.push(invoice);
      byPos.set(invoice.placeOfSupplyStateCode, bucket);
    }

    return [...byPos.entries()].map(([pos, group]) => ({
      pos,
      inv: group.map((invoice) => ({
        inum: invoice.number ?? '',
        idt: this.portalDate(invoice.invoiceDate),
        val: num(Money.of(invoice.grandTotal.toFixed(4))),
        itms: this.rateWiseItems(invoice.lines),
      })),
    }));
  }

  /** Table 7 is consolidated per (supply type, place of supply, rate) — not invoice-wise. */
  private buildB2cs(invoices: readonly InvoiceForReturn[]) {
    const groups = new Map<
      string,
      {
        sply_ty: 'INTER' | 'INTRA';
        pos: string;
        rt: number;
        txval: Money;
        iamt: Money;
        camt: Money;
        samt: Money;
        csamt: Money;
      }
    >();

    for (const invoice of invoices) {
      if (invoice.supplyType !== 'B2CS') continue;
      const interState = GstCalculator.isInterState(
        invoice.supplierStateCode,
        invoice.placeOfSupplyStateCode,
      );

      for (const line of invoice.lines) {
        const rate = Number(line.gstRate.toFixed(2));
        const key = `${interState ? 'INTER' : 'INTRA'}:${invoice.placeOfSupplyStateCode}:${rate}`;
        const group = groups.get(key) ?? {
          sply_ty: interState ? ('INTER' as const) : ('INTRA' as const),
          pos: invoice.placeOfSupplyStateCode,
          rt: rate,
          txval: Money.zero(),
          iamt: Money.zero(),
          camt: Money.zero(),
          samt: Money.zero(),
          csamt: Money.zero(),
        };

        group.txval = group.txval.add(line.taxableValue.toFixed(4));
        group.iamt = group.iamt.add(line.igst.toFixed(4));
        group.camt = group.camt.add(line.cgst.toFixed(4));
        group.samt = group.samt.add(line.sgst.toFixed(4));
        group.csamt = group.csamt.add(line.cess.toFixed(4));
        groups.set(key, group);
      }
    }

    return [...groups.values()].map((group) => ({
      sply_ty: group.sply_ty,
      pos: group.pos,
      typ: 'OE' as const,
      rt: group.rt,
      txval: num(group.txval),
      iamt: num(group.iamt),
      camt: num(group.camt),
      samt: num(group.samt),
      csamt: num(group.csamt),
    }));
  }

  private buildCdnr(notes: readonly NoteForReturn[]) {
    const byGstin = new Map<string, NoteForReturn[]>();
    for (const note of notes) {
      if (!note.counterpartyGstin) continue;
      const bucket = byGstin.get(note.counterpartyGstin) ?? [];
      bucket.push(note);
      byGstin.set(note.counterpartyGstin, bucket);
    }

    return [...byGstin.entries()].map(([ctin, group]) => ({
      ctin,
      nt: group.map((note) => ({
        ntty: note.type === 'CREDIT' ? ('C' as const) : ('D' as const),
        nt_num: note.number ?? '',
        nt_dt: this.portalDate(note.noteDate),
        inum: note.originalInvoice.number ?? '',
        idt: this.portalDate(note.originalInvoice.invoiceDate),
        pos: note.placeOfSupplyStateCode,
        rchrg: 'N' as const,
        val: num(Money.of(note.grandTotal.toFixed(4))),
        itms: this.rateWiseItems(note.lines),
      })),
    }));
  }

  /** Table 12 — HSN-wise, aggregated across every invoice in the period. */
  private buildHsn(invoices: readonly InvoiceForReturn[]) {
    const byHsn = new Map<
      string,
      {
        hsn: string;
        desc: string;
        uqc: string;
        qty: Money;
        txval: Money;
        iamt: Money;
        camt: Money;
        samt: Money;
        csamt: Money;
        rt: number;
      }
    >();

    for (const invoice of invoices) {
      for (const line of invoice.lines) {
        const hsn = line.hsnSacCode ?? 'UNCLASSIFIED';
        const rate = Number(line.gstRate.toFixed(2));
        const key = `${hsn}:${rate}`;
        const group = byHsn.get(key) ?? {
          hsn,
          desc: line.description,
          uqc: (line.uomCode ?? 'OTH').toUpperCase(),
          qty: Money.zero(),
          txval: Money.zero(),
          iamt: Money.zero(),
          camt: Money.zero(),
          samt: Money.zero(),
          csamt: Money.zero(),
          rt: rate,
        };

        group.qty = group.qty.add(line.quantity.toFixed(4));
        group.txval = group.txval.add(line.taxableValue.toFixed(4));
        group.iamt = group.iamt.add(line.igst.toFixed(4));
        group.camt = group.camt.add(line.cgst.toFixed(4));
        group.samt = group.samt.add(line.sgst.toFixed(4));
        group.csamt = group.csamt.add(line.cess.toFixed(4));
        byHsn.set(key, group);
      }
    }

    return [...byHsn.values()].map((group, index) => ({
      num: index + 1,
      hsn_sc: group.hsn,
      desc: group.desc.slice(0, 30),
      uqc: group.uqc,
      qty: num(group.qty),
      txval: num(group.txval),
      iamt: num(group.iamt),
      camt: num(group.camt),
      samt: num(group.samt),
      csamt: num(group.csamt),
      rt: group.rt,
    }));
  }

  /**
   * Table 13 — documents issued.
   *
   * The ONE place a cancelled invoice appears. It keeps its number and is
   * reported in the cancelled count, because the series must be continuous:
   * a number that vanishes is the gap the whole design exists to prevent
   * (docs/23 §5.2).
   */
  private buildDocsIssued(invoices: readonly InvoiceForReturn[], notes: readonly NoteForReturn[]) {
    const sections: Array<{
      doc_num: number;
      doc_typ: string;
      numbers: string[];
      cancelled: number;
    }> = [
      {
        doc_num: 1,
        doc_typ: 'Invoices for outward supply',
        numbers: invoices.map((invoice) => invoice.number ?? '').filter(Boolean),
        cancelled: invoices.filter((invoice) => invoice.status === 'CANCELLED').length,
      },
      {
        doc_num: 4,
        doc_typ: 'Debit Note',
        numbers: notes
          .filter((note) => note.type === 'DEBIT')
          .map((note) => note.number ?? '')
          .filter(Boolean),
        cancelled: 0,
      },
      {
        doc_num: 5,
        doc_typ: 'Credit Note',
        numbers: notes
          .filter((note) => note.type === 'CREDIT')
          .map((note) => note.number ?? '')
          .filter(Boolean),
        cancelled: 0,
      },
    ];

    return sections
      .filter((section) => section.numbers.length > 0)
      .map((section) => {
        const sorted = [...section.numbers].sort();
        const total = sorted.length;
        return {
          doc_num: section.doc_num,
          doc_typ: section.doc_typ,
          docs: [
            {
              num: 1,
              from: sorted[0] ?? '',
              to: sorted[total - 1] ?? '',
              totnum: total,
              cancel: section.cancelled,
              net_issue: total - section.cancelled,
            },
          ],
        };
      });
  }

  private buildSummary(
    invoices: readonly InvoiceForReturn[],
    notes: readonly NoteForReturn[],
    excludedSecondaryCount: number,
  ) {
    const live = invoices.filter((invoice) => invoice.status !== 'CANCELLED');

    let taxable = Money.zero();
    let cgst = Money.zero();
    let sgst = Money.zero();
    let igst = Money.zero();
    let cess = Money.zero();
    let value = Money.zero();

    for (const invoice of live) {
      for (const line of invoice.lines) {
        taxable = taxable.add(line.taxableValue.toFixed(4));
        cgst = cgst.add(line.cgst.toFixed(4));
        sgst = sgst.add(line.sgst.toFixed(4));
        igst = igst.add(line.igst.toFixed(4));
        cess = cess.add(line.cess.toFixed(4));
      }
      value = value.add(invoice.grandTotal.toFixed(4));
    }

    return {
      invoiceCount: live.length,
      cancelledCount: invoices.length - live.length,
      creditNoteCount: notes.filter((note) => note.type === 'CREDIT').length,
      debitNoteCount: notes.filter((note) => note.type === 'DEBIT').length,
      totalTaxableValue: taxable.toString(),
      totalCgst: cgst.toString(),
      totalSgst: sgst.toString(),
      totalIgst: igst.toString(),
      totalCess: cess.toString(),
      totalTax: cgst.add(sgst).add(igst).add(cess).toString(),
      totalInvoiceValue: value.toString(),
      excludedSecondaryCount,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * The period filter every section shares.
   *
   * DRAFT is excluded (it is not a document yet) but CANCELLED is NOT — table
   * 13 needs it. Sections that must not see it filter it out themselves.
   */
  private periodWhere(from: Date, to: Date): Prisma.InvoiceWhereInput {
    return {
      invoiceDate: { gte: from, lte: to },
      status: { not: 'DRAFT' },
      // The SECONDARY exclusion (ADR-0014 §6). `orderId: null` keeps direct
      // invoices, which have no order and are Hixaa's own supply.
      OR: [{ orderId: null }, { order: { type: 'PRIMARY' } }],
    };
  }

  private rateWiseItems(
    lines: ReadonlyArray<{
      taxableValue: Prisma.Decimal;
      gstRate: Prisma.Decimal;
      cgst: Prisma.Decimal;
      sgst: Prisma.Decimal;
      igst: Prisma.Decimal;
      cess: Prisma.Decimal;
    }>,
  ) {
    // The portal groups an invoice's lines by RATE, not one entry per line.
    const byRate = new Map<
      number,
      { txval: Money; iamt: Money; camt: Money; samt: Money; csamt: Money }
    >();

    for (const line of lines) {
      const rate = Number(line.gstRate.toFixed(2));
      const group = byRate.get(rate) ?? {
        txval: Money.zero(),
        iamt: Money.zero(),
        camt: Money.zero(),
        samt: Money.zero(),
        csamt: Money.zero(),
      };
      group.txval = group.txval.add(line.taxableValue.toFixed(4));
      group.iamt = group.iamt.add(line.igst.toFixed(4));
      group.camt = group.camt.add(line.cgst.toFixed(4));
      group.samt = group.samt.add(line.sgst.toFixed(4));
      group.csamt = group.csamt.add(line.cess.toFixed(4));
      byRate.set(rate, group);
    }

    return [...byRate.entries()].map(([rate, group], index) => ({
      num: index + 1,
      itm_det: {
        rt: rate,
        txval: num(group.txval),
        iamt: num(group.iamt),
        camt: num(group.camt),
        samt: num(group.samt),
        csamt: num(group.csamt),
      },
    }));
  }

  private range(query: GstReturnQuery): { from: Date; to: Date } {
    const from = new Date(`${query.from}T00:00:00.000Z`);
    const to = new Date(`${query.to}T00:00:00.000Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new ValidationError('`from` and `to` must be YYYY-MM-DD dates');
    }
    return { from, to };
  }

  /** The portal wants `DD-MM-YYYY`. */
  private portalDate(date: Date): string {
    const iso = date.toISOString().slice(0, 10);
    const [year, month, day] = iso.split('-');
    return `${day}-${month}-${year}`;
  }
}

/**
 * The single boundary where money becomes a JSON number.
 *
 * Two decimals, matching what the portal accepts. Everything upstream is
 * `Money`, so this is the only place precision can be lost and it is lost
 * exactly where the schema requires it (ADR-0004).
 */
const num = (value: Money): number => Number(value.toDisplayString());

type InvoiceForReturn = {
  id: string;
  number: string | null;
  status: string;
  invoiceDate: Date;
  supplyType: string;
  isReverseCharge: boolean;
  counterpartyGstin: string | null;
  placeOfSupplyStateCode: string;
  supplierStateCode: string;
  grandTotal: Prisma.Decimal;
  lines: Array<{
    taxableValue: Prisma.Decimal;
    gstRate: Prisma.Decimal;
    cgst: Prisma.Decimal;
    sgst: Prisma.Decimal;
    igst: Prisma.Decimal;
    cess: Prisma.Decimal;
    hsnSacCode: string | null;
    description: string;
    quantity: Prisma.Decimal;
    uomCode: string | null;
  }>;
};

type NoteForReturn = {
  type: string;
  number: string | null;
  noteDate: Date;
  counterpartyGstin: string | null;
  placeOfSupplyStateCode: string;
  grandTotal: Prisma.Decimal;
  originalInvoice: { number: string | null; invoiceDate: Date };
  lines: Array<{
    taxableValue: Prisma.Decimal;
    gstRate: Prisma.Decimal;
    cgst: Prisma.Decimal;
    sgst: Prisma.Decimal;
    igst: Prisma.Decimal;
    cess: Prisma.Decimal;
  }>;
};
