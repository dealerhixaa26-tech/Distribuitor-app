import { Injectable } from '@nestjs/common';
import { GST_STATE_CODES, Money, amountInWords, formatIndianDigits } from '@hixaa/contracts';
import type { Content, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces';
import { PinoLogger } from 'nestjs-pino';
import { ConflictError, NotFoundError } from '../../common/errors/domain.error';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { DocumentRendererService } from '../documents/document-renderer.service';

/**
 * The tax invoice PDF — a SIBLING of the quotation, not a copy of it.
 *
 * Page setup, fonts, styles, the letterhead, the party block and the footer all
 * come from `DocumentRendererService` (ADR-0013). This file supplies content
 * and the handful of things a tax invoice must say that a quotation must not.
 *
 * ── What Rule 46 requires, and this prints ─────────────────────────────────
 *   • The words "TAX INVOICE" and a consecutive serial number
 *   • Supplier and recipient name, address and GSTIN
 *   • HSN/SAC per line, rate-wise tax split, place of supply
 *   • Total in words
 *   • Whether tax is payable on reverse charge
 *   • A signature block
 *
 * ── And the one thing it refuses to do ─────────────────────────────────────
 * A DRAFT invoice renders with a prominent DRAFT watermark and no invoice
 * number, because it has none. Producing a document that looks like a tax
 * invoice but carries no valid number is a compliance problem for whoever
 * receives it — the same reasoning that puts "this is not a tax invoice" on the
 * quotation.
 */
@Injectable()
export class InvoicePdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: DocumentRendererService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InvoicePdfService.name);
  }

  async render(invoiceId: string): Promise<{ buffer: Buffer; filename: string }> {
    const invoice = await this.load(invoiceId);
    const company = await this.renderer.companyProfile();

    // An unverified statutory identity blocks ISSUE, not preview — but it must
    // never produce something that reads as a real tax invoice.
    if (invoice.status !== 'DRAFT' && !company.statutoryVerified) {
      throw new ConflictError(
        'The company’s GST registration is unverified, yet this invoice is issued. That should ' +
          'not be possible — refusing to render rather than producing a document under an ' +
          'unconfirmed GSTIN.',
      );
    }

    const isInterState = Money.of(invoice.totalIgst.toFixed(4)).isPositive();
    const isDraft = invoice.status === 'DRAFT';
    const isCancelled = invoice.status === 'CANCELLED';

    const definition: TDocumentDefinitions = {
      pageSize: 'A4',
      pageMargins: [36, 36, 36, 54],
      info: {
        title: isDraft ? 'Draft invoice' : `Tax Invoice ${invoice.number}`,
        author: company.legalName,
        subject: `Tax invoice for ${invoice.counterpartyName}`,
      },
      // pdfmake renders `watermark` behind the content on every page, which is
      // what makes a draft unmistakable even when printed and passed on.
      ...(isDraft ? { watermark: { text: 'DRAFT', opacity: 0.12, bold: true } } : {}),
      ...(isCancelled ? { watermark: { text: 'CANCELLED', opacity: 0.15, bold: true } } : {}),
      footer: this.renderer.footer(
        isDraft
          ? 'DRAFT — not a tax invoice. No statutory number has been allocated.'
          : 'This is a computer-generated tax invoice.',
      ),
      content: [
        this.renderer.header(
          company,
          isDraft ? 'DRAFT INVOICE' : 'TAX INVOICE',
          isDraft ? 'Not yet issued' : (invoice.number ?? ''),
        ),
        this.divider(company.primaryColour),
        this.meta(invoice),
        { text: '', margin: [0, 6, 0, 0] },
        this.parties(invoice),
        { text: '', margin: [0, 10, 0, 0] },
        this.lineTable(invoice, isInterState),
        this.totals(invoice, isInterState),
        this.words(invoice),
        ...this.reverseChargeNote(invoice),
        ...this.cancelledNote(invoice),
        ...this.terms(invoice),
        this.signature(company.legalName),
      ],
    };

    const buffer = await this.renderer.render(definition);
    const stem = invoice.number ?? `DRAFT-${invoice.id.slice(0, 8)}`;
    return { buffer, filename: `${stem.replace(/[^\w.-]/g, '-')}.pdf` };
  }

  // ── Sections ──────────────────────────────────────────────────────────────

  private divider(colour: string): Content {
    return {
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: 523, y2: 0, lineWidth: 2, lineColor: colour }],
      margin: [0, 0, 0, 8],
    };
  }

  private meta(invoice: InvoiceRecord): Content {
    const pos = invoice.placeOfSupplyStateCode;
    const posName = (GST_STATE_CODES as Record<string, string>)[pos];

    return {
      columns: [
        {
          width: '*',
          stack: [
            this.field('Invoice date', this.date(invoice.invoiceDate)),
            this.field('Due date', invoice.dueDate ? this.date(invoice.dueDate) : 'On receipt'),
          ],
        },
        {
          width: '*',
          stack: [
            this.field(
              'Place of supply',
              posName ? `${pos} — ${posName}` : pos,
            ),
            this.field(
              'Reverse charge',
              invoice.isReverseCharge ? 'Yes' : 'No',
            ),
          ],
        },
        {
          width: '*',
          stack: [
            this.field('Order', invoice.order?.number ?? '—'),
            this.field('Your PO', invoice.customerPoNumber ?? '—'),
          ],
          alignment: 'right' as const,
        },
      ],
    };
  }

  private field(label: string, value: string): Content {
    return { text: [{ text: `${label}  `, style: 'sectionLabel' }, { text: value, style: 'small' }] };
  }

  private parties(invoice: InvoiceRecord): Content {
    const address = invoice.distributor?.billingAddress ?? invoice.customer?.billingAddress;
    const shipping = invoice.distributor?.shippingAddress ?? invoice.customer?.shippingAddress;

    return {
      columns: [
        this.renderer.partyBlock('BILL TO', [
          invoice.counterpartyName,
          address?.line1,
          address?.line2,
          address ? [address.cityName, address.postalCode].filter(Boolean).join(' ') : null,
          // Rule 46(f): the recipient's GSTIN, without which they cannot claim
          // input credit.
          invoice.counterpartyGstin ? `GSTIN ${invoice.counterpartyGstin}` : 'Unregistered',
        ]),
        this.renderer.partyBlock('SHIP TO', [
          invoice.counterpartyName,
          shipping?.line1 ?? address?.line1,
          shipping?.line2 ?? address?.line2,
          shipping
            ? [shipping.cityName, shipping.postalCode].filter(Boolean).join(' ')
            : address
              ? [address.cityName, address.postalCode].filter(Boolean).join(' ')
              : null,
        ]),
      ],
      columnGap: 24,
    };
  }

  private lineTable(invoice: InvoiceRecord, isInterState: boolean): Content {
    const taxHeaders: TableCell[] = isInterState
      ? [{ text: 'IGST', style: 'tableHeader', alignment: 'right' as const }]
      : [
          { text: 'CGST', style: 'tableHeader', alignment: 'right' as const },
          { text: 'SGST', style: 'tableHeader', alignment: 'right' as const },
        ];

    const widths = isInterState
      ? [16, '*', 46, 30, 30, 52, 30, 48, 56]
      : [16, '*', 46, 28, 28, 50, 26, 38, 38, 54];

    const body: TableCell[][] = [
      [
        { text: '#', style: 'tableHeader' },
        { text: 'Description', style: 'tableHeader' },
        { text: 'HSN/SAC', style: 'tableHeader' },
        { text: 'Qty', style: 'tableHeader', alignment: 'right' as const },
        { text: 'UOM', style: 'tableHeader' },
        { text: 'Rate', style: 'tableHeader', alignment: 'right' as const },
        { text: '%', style: 'tableHeader', alignment: 'right' as const },
        ...taxHeaders,
        { text: 'Amount', style: 'tableHeader', alignment: 'right' as const },
      ],
    ];

    for (const line of invoice.lines) {
      const discount = Money.of(line.discountAmount.toFixed(4));
      body.push([
        { text: String(line.lineNumber), style: 'cell' },
        {
          stack: [
            { text: line.description, style: 'cell' },
            { text: line.sku, fontSize: 7, color: '#777777' },
            ...(discount.isPositive()
              ? [
                  {
                    text: `Less discount ${Money.of(line.discountPercent.toFixed(2)).toDisplayString()}%  (−₹${formatIndianDigits(discount.toString())})`,
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
        { text: `${Money.of(line.gstRate.toFixed(2)).toDisplayString()}`, style: 'cellRight' },
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

  private totals(invoice: InvoiceRecord, isInterState: boolean): Content {
    const rows: Array<[string, string, boolean]> = [
      ['Taxable value', invoice.taxableValue.toFixed(4), false],
    ];

    if (isInterState) {
      rows.push(['IGST', invoice.totalIgst.toFixed(4), false]);
    } else {
      rows.push(['CGST', invoice.totalCgst.toFixed(4), false]);
      rows.push(['SGST', invoice.totalSgst.toFixed(4), false]);
    }

    const cess = Money.of(invoice.totalCess.toFixed(4));
    if (cess.isPositive()) rows.push(['Cess', cess.toString(), false]);

    const roundOff = Money.of(invoice.roundOff.toFixed(4));
    if (!roundOff.isZero()) rows.push(['Round off', roundOff.toString(), false]);

    rows.push(['Invoice total', invoice.grandTotal.toFixed(4), true]);

    // What is still owed, shown only when it differs from the total — a fully
    // settled invoice showing "Amount due ₹0.00" is noise, and one showing the
    // full total when half is paid is misleading.
    const outstanding = Money.of(invoice.amountOutstanding.toFixed(4));
    const grandTotal = Money.of(invoice.grandTotal.toFixed(4));
    if (!outstanding.equals(grandTotal)) {
      rows.push(['Amount due', outstanding.toString(), false]);
    }

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

  /** Rule 46(g): the total in words. */
  private words(invoice: InvoiceRecord): Content {
    return {
      text: amountInWords(invoice.grandTotal.toFixed(4)),
      style: 'words',
      margin: [0, 0, 0, 10],
    };
  }

  private reverseChargeNote(invoice: InvoiceRecord): Content[] {
    if (!invoice.isReverseCharge) return [];
    return [
      {
        text:
          'Tax is payable on REVERSE CHARGE basis. The recipient is liable to pay GST on this ' +
          'supply under section 9(3)/9(4) of the CGST Act.',
        style: 'warning',
        margin: [0, 4, 0, 6],
      },
    ];
  }

  private cancelledNote(invoice: InvoiceRecord): Content[] {
    if (invoice.status !== 'CANCELLED') return [];
    return [
      {
        text:
          `This invoice was CANCELLED${invoice.cancelledReason ? ` — ${invoice.cancelledReason}` : ''}. ` +
          'Its number is retained and reported as cancelled; it has not been reissued.',
        style: 'warning',
        margin: [0, 4, 0, 6],
      },
    ];
  }

  private terms(invoice: InvoiceRecord): Content[] {
    if (!invoice.termsAndConditions && !invoice.notes) return [];
    return [
      { text: 'TERMS & CONDITIONS', style: 'sectionLabel', margin: [0, 6, 0, 2] },
      { text: invoice.termsAndConditions ?? invoice.notes ?? '', style: 'small' },
    ];
  }

  /** Rule 46(q): signature or digital signature of the supplier. */
  private signature(legalName: string): Content {
    return {
      columns: [
        { width: '*', text: '' },
        {
          width: 200,
          stack: [
            { text: `For ${legalName}`, style: 'small', alignment: 'right' },
            { text: '\n\n', style: 'small' },
            {
              text: 'Authorised Signatory',
              style: 'sectionLabel',
              alignment: 'right',
            },
          ],
        },
      ],
      margin: [0, 24, 0, 0],
    };
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
    const invoice = await this.prisma.db.invoice.findFirst({
      where: { id },
      select: {
        id: true,
        number: true,
        status: true,
        invoiceDate: true,
        dueDate: true,
        placeOfSupplyStateCode: true,
        isReverseCharge: true,
        counterpartyName: true,
        counterpartyGstin: true,
        customerPoNumber: true,
        taxableValue: true,
        totalCgst: true,
        totalSgst: true,
        totalIgst: true,
        totalCess: true,
        roundOff: true,
        grandTotal: true,
        amountOutstanding: true,
        cancelledReason: true,
        termsAndConditions: true,
        notes: true,
        order: { select: { number: true } },
        distributor: {
          select: {
            billingAddress: {
              select: { line1: true, line2: true, cityName: true, postalCode: true },
            },
            shippingAddress: {
              select: { line1: true, line2: true, cityName: true, postalCode: true },
            },
          },
        },
        customer: {
          select: {
            billingAddress: {
              select: { line1: true, line2: true, cityName: true, postalCode: true },
            },
            shippingAddress: {
              select: { line1: true, line2: true, cityName: true, postalCode: true },
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
            gstRate: true,
            cgst: true,
            sgst: true,
            igst: true,
            lineTotal: true,
          },
        },
      },
    });
    if (!invoice) throw new NotFoundError('Invoice', id);
    return invoice;
  }
}

type InvoiceRecord = Awaited<ReturnType<InvoicePdfService['load']>>;
