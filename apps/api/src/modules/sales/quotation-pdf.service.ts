import { Injectable } from '@nestjs/common';
import { Money, amountInWords, formatIndianDigits } from '@hixaa/contracts';
import type { Content, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces';
import { PinoLogger } from 'nestjs-pino';
import { NotFoundError } from '../../common/errors/domain.error';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { DocumentRendererService } from '../documents/document-renderer.service';

/**
 * The quotation PDF — Hixaa's primary customer-facing artefact.
 *
 * Supplies content only; page setup, fonts, styles, and the company letterhead
 * come from `DocumentRendererService` (ADR-0013). Phase 8's tax invoice will be
 * a sibling of this file, not a copy of it.
 *
 * ── What it must say, and why ──────────────────────────────────────────────
 * A quotation is not a tax invoice, and the footer says so explicitly. Getting
 * that wrong is not cosmetic: a document that looks like a tax invoice but
 * carries no valid invoice number is a compliance problem for whoever receives
 * it, and the GST split shown here is an estimate at today's rates rather than
 * a levy.
 */
@Injectable()
export class QuotationPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: DocumentRendererService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(QuotationPdfService.name);
  }

  async render(quotationId: string): Promise<{ buffer: Buffer; filename: string }> {
    const quotation = await this.load(quotationId);
    const company = await this.renderer.companyProfile();

    const isInterState = Money.of(quotation.totalIgst.toFixed(4)).isPositive();

    const definition: TDocumentDefinitions = {
      pageSize: 'A4',
      pageMargins: [36, 36, 36, 54],
      info: {
        title: `Quotation ${quotation.number}`,
        author: company.legalName,
        subject: `Quotation for ${this.counterpartyName(quotation)}`,
      },
      footer: this.renderer.footer(
        'This is a quotation, not a tax invoice. Prices and taxes are indicative at today’s rates.',
      ),
      content: [
        this.renderer.header(
          company,
          'QUOTATION',
          `${quotation.number}${quotation.revision > 1 ? `  ·  Revision ${quotation.revision}` : ''}`,
        ),
        this.divider(company.primaryColour),
        this.meta(quotation),
        { text: '', margin: [0, 6, 0, 0] },
        this.parties(quotation),
        { text: '', margin: [0, 10, 0, 0] },
        this.lineTable(quotation, isInterState),
        this.totals(quotation, isInterState),
        this.words(quotation),
        ...this.terms(quotation),
        ...this.statutoryWarning(company),
      ],
    };

    const buffer = await this.renderer.render(definition);
    return { buffer, filename: `${quotation.number.replace(/[^\w.-]/g, '-')}.pdf` };
  }

  // ── Sections ──────────────────────────────────────────────────────────────

  private divider(colour: string): Content {
    return {
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: 523, y2: 0, lineWidth: 2, lineColor: colour }],
      margin: [0, 0, 0, 8],
    };
  }

  private meta(quotation: QuotationRecord): Content {
    return {
      columns: [
        {
          width: '*',
          text: [
            { text: 'Date  ', style: 'sectionLabel' },
            { text: this.date(quotation.quotationDate), style: 'small' },
          ],
        },
        {
          width: '*',
          text: [
            { text: 'Valid until  ', style: 'sectionLabel' },
            {
              text: quotation.validUntil ? this.date(quotation.validUntil) : 'Not specified',
              style: 'small',
            },
          ],
        },
        {
          width: '*',
          text: [
            { text: 'Place of supply  ', style: 'sectionLabel' },
            { text: quotation.placeOfSupplyStateCode ?? '—', style: 'small' },
          ],
          alignment: 'right' as const,
        },
      ],
    };
  }

  private parties(quotation: QuotationRecord): Content {
    const party = quotation.distributor ?? quotation.customer;
    const address = quotation.distributor?.billingAddress ?? quotation.customer?.billingAddress;

    return {
      columns: [
        this.renderer.partyBlock('QUOTATION FOR', [
          this.counterpartyName(quotation),
          address?.line1,
          address?.line2,
          address ? [address.cityName, address.postalCode].filter(Boolean).join(' ') : null,
          party && 'gstin' in party && party.gstin ? `GSTIN ${party.gstin}` : null,
        ]),
        this.renderer.partyBlock('CONTACT', [
          quotation.distributor?.contacts?.[0]?.name ?? quotation.customer?.contacts?.[0]?.name,
          quotation.distributor?.contacts?.[0]?.email ?? quotation.customer?.contacts?.[0]?.email,
          quotation.distributor?.contacts?.[0]?.phone ?? quotation.customer?.contacts?.[0]?.phone,
        ]),
      ],
      columnGap: 24,
    };
  }

  /**
   * The line table.
   *
   * HSN/SAC is a column because an industrial buyer's accounts team needs it to
   * book the purchase, and CGST/SGST versus IGST are shown as separate columns
   * because that is how an Indian buyer reads a document — a single "tax"
   * figure is not usable for input-credit purposes.
   */
  private lineTable(quotation: QuotationRecord, isInterState: boolean): Content {
    // `as const` on the alignment: without it TypeScript widens 'right' to
    // `string`, which pdfmake's `Alignment` union rejects.
    const taxHeaders: TableCell[] = isInterState
      ? [{ text: 'IGST', style: 'tableHeader', alignment: 'right' as const }]
      : [
          { text: 'CGST', style: 'tableHeader', alignment: 'right' as const },
          { text: 'SGST', style: 'tableHeader', alignment: 'right' as const },
        ];

    const widths = isInterState
      ? [16, '*', 46, 30, 34, 52, 44, 52, 58]
      : [16, '*', 46, 30, 34, 52, 40, 40, 58];

    const body: TableCell[][] = [
      [
        { text: '#', style: 'tableHeader' },
        { text: 'Description', style: 'tableHeader' },
        { text: 'HSN/SAC', style: 'tableHeader' },
        { text: 'Qty', style: 'tableHeader', alignment: 'right' as const },
        { text: 'UOM', style: 'tableHeader' },
        { text: 'Rate', style: 'tableHeader', alignment: 'right' as const },
        ...taxHeaders,
        { text: 'Amount', style: 'tableHeader', alignment: 'right' as const },
      ],
    ];

    for (const line of quotation.lines) {
      const discount = Money.of(line.discountAmount.toFixed(4));
      body.push([
        { text: String(line.lineNumber), style: 'cell' },
        {
          stack: [
            { text: line.description, style: 'cell' },
            { text: line.sku, fontSize: 7, color: '#777777' },
            // A discount is shown rather than silently folded into the rate —
            // the customer should see the concession they were given.
            ...(discount.isPositive()
              ? [
                  {
                    text: `Discount ${Money.of(line.discountPercent.toFixed(2)).toDisplayString()}%  (−₹${formatIndianDigits(discount.toString())})`,
                    fontSize: 7,
                    color: '#0057B8',
                  },
                ]
              : []),
          ],
        },
        { text: line.hsnSacCode ?? '—', style: 'cell' },
        { text: formatIndianDigits(line.quantity.toFixed(4), 0), style: 'cellRight' },
        { text: line.uomCode ?? '', style: 'cell' },
        { text: formatIndianDigits(line.unitPrice.toFixed(4)), style: 'cellRight' },
        ...(isInterState
          ? [{ text: formatIndianDigits(line.igst.toFixed(4)), style: 'cellRight' }]
          : [
              { text: formatIndianDigits(line.cgst.toFixed(4)), style: 'cellRight' },
              { text: formatIndianDigits(line.sgst.toFixed(4)), style: 'cellRight' },
            ]),
        { text: formatIndianDigits(line.lineTotal.toFixed(4)), style: 'cellRight' },
      ]);
    }

    return {
      table: { headerRows: 1, widths, body, dontBreakRows: true },
      layout: {
        hLineWidth: (i: number) => (i <= 1 ? 0.8 : 0.3),
        vLineWidth: () => 0,
        hLineColor: (i: number) => (i <= 1 ? '#333333' : '#DDDDDD'),
        paddingTop: () => 4,
        paddingBottom: () => 4,
      },
      margin: [0, 0, 0, 8],
    };
  }

  private totals(quotation: QuotationRecord, isInterState: boolean): Content {
    const rows: Array<[string, string, boolean]> = [
      ['Subtotal', quotation.subtotal.toFixed(4), false],
    ];

    const discount = Money.of(quotation.totalDiscount.toFixed(4));
    if (discount.isPositive()) rows.push(['Discount', `−${discount.toString()}`, false]);

    rows.push(['Taxable value', quotation.taxableValue.toFixed(4), false]);

    if (isInterState) {
      rows.push(['IGST', quotation.totalIgst.toFixed(4), false]);
    } else {
      rows.push(['CGST', quotation.totalCgst.toFixed(4), false]);
      rows.push(['SGST', quotation.totalSgst.toFixed(4), false]);
    }

    const roundOff = Money.of(quotation.roundOff.toFixed(4));
    if (!roundOff.isZero()) rows.push(['Round off', roundOff.toString(), false]);

    rows.push(['Total', quotation.grandTotal.toFixed(4), true]);

    return {
      columns: [
        { width: '*', text: '' },
        {
          width: 230,
          table: {
            widths: ['*', 90],
            body: rows.map(([label, value, emphasise]) => [
              { text: label, style: emphasise ? 'grandTotal' : 'totalLabel' },
              {
                text: `₹ ${formatIndianDigits(value)}`,
                style: emphasise ? 'grandTotal' : 'totalValue',
              },
            ]),
          },
          layout: {
            hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
              i === node.table.body.length - 1 ? 0.8 : 0,
            vLineWidth: () => 0,
            hLineColor: () => '#333333',
            paddingTop: () => 2,
            paddingBottom: () => 2,
          },
        },
      ],
      margin: [0, 0, 0, 8],
    };
  }

  private words(quotation: QuotationRecord): Content {
    return {
      text: amountInWords(quotation.grandTotal.toFixed(4)),
      style: 'words',
      margin: [0, 0, 0, 10],
    };
  }

  private terms(quotation: QuotationRecord): Content[] {
    if (!quotation.termsAndConditions && !quotation.notes) return [];
    return [
      { text: 'TERMS & CONDITIONS', style: 'sectionLabel', margin: [0, 6, 0, 2] },
      { text: quotation.termsAndConditions ?? quotation.notes ?? '', style: 'small' },
    ];
  }

  /**
   * Warns when the company's own statutory identity is unverified.
   *
   * `company.statutory.verified` is `false` until the owner supplies the real
   * GSTIN (open question E1). A quotation may still go out — it is not a tax
   * document — but it should not silently imply a registration that has not
   * been confirmed.
   */
  private statutoryWarning(company: { statutoryVerified: boolean; gstin: string | null }): Content[] {
    if (company.statutoryVerified && company.gstin) return [];
    return [
      {
        text:
          'Note: the issuing company’s GST registration details are pending verification in this ' +
          'system. This document is indicative and must not be treated as a tax invoice.',
        style: 'warning',
        margin: [0, 12, 0, 0],
      },
    ];
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  private counterpartyName(quotation: QuotationRecord): string {
    return quotation.distributor?.legalName ?? quotation.customer?.name ?? 'Customer';
  }

  private date(value: Date): string {
    return new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Kolkata',
    }).format(value);
  }

  private async load(id: string) {
    const quotation = await this.prisma.db.quotation.findFirst({
      where: { id },
      select: {
        id: true,
        number: true,
        revision: true,
        quotationDate: true,
        validUntil: true,
        placeOfSupplyStateCode: true,
        subtotal: true,
        totalDiscount: true,
        taxableValue: true,
        totalCgst: true,
        totalSgst: true,
        totalIgst: true,
        totalTax: true,
        roundOff: true,
        grandTotal: true,
        termsAndConditions: true,
        notes: true,
        distributor: {
          select: {
            legalName: true,
            gstin: true,
            billingAddress: {
              select: { line1: true, line2: true, cityName: true, postalCode: true },
            },
            contacts: {
              where: { isPrimary: true },
              take: 1,
              select: { name: true, email: true, phone: true },
            },
          },
        },
        customer: {
          select: {
            name: true,
            gstin: true,
            billingAddress: {
              select: { line1: true, line2: true, cityName: true, postalCode: true },
            },
            contacts: {
              where: { isPrimary: true },
              take: 1,
              select: { name: true, email: true, phone: true },
            },
          },
        },
        lines: {
          orderBy: { lineNumber: 'asc' },
          select: {
            lineNumber: true,
            sku: true,
            description: true,
            quantity: true,
            uomCode: true,
            unitPrice: true,
            discountAmount: true,
            discountPercent: true,
            hsnSacCode: true,
            cgst: true,
            sgst: true,
            igst: true,
            lineTotal: true,
          },
        },
      },
    });
    if (!quotation) throw new NotFoundError('Quotation', id);
    return quotation;
  }
}

type QuotationRecord = Awaited<ReturnType<QuotationPdfService['load']>>;
