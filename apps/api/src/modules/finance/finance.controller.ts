import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  allocatePaymentSchema,
  bouncePaymentSchema,
  cancelInvoiceSchema,
  createInvoiceFromOrderSchema,
  createInvoiceFromShipmentSchema,
  createInvoiceSchema,
  createPaymentSchema,
  createTaxNoteSchema,
  gstReturnQuerySchema,
  issueInvoiceSchema,
  issueTaxNoteSchema,
  ledgerAdjustmentSchema,
  ledgerPartyTypeSchema,
  listInvoicesQuerySchema,
  listOutstandingQuerySchema,
  listPartyLedgerQuerySchema,
  listPaymentsQuerySchema,
  listTaxNotesQuerySchema,
  updateInvoiceSchema,
  updatePaymentSchema,
  uuidSchema,
  verifyPaymentSchema,
  writeOffSchema,
  type AllocatePaymentDto,
  type CreateInvoiceDto,
  type CreateInvoiceFromOrderDto,
  type CreatePaymentDto,
  type CreateTaxNoteDto,
  type GstReturnQuery,
  type LedgerAdjustmentDto,
  type LedgerPartyType,
  type ListInvoicesQuery,
  type ListOutstandingQuery,
  type ListPartyLedgerQuery,
  type ListPaymentsQuery,
  type ListTaxNotesQuery,
  type UpdateInvoiceDto,
  type UpdatePaymentDto,
  type VerifyPaymentDto,
  type WriteOffDto,
} from '@hixaa/contracts';
import type { Response } from 'express';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { GstReturnsService } from './gst-returns.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoicesService } from './invoices.service';
import { LedgerService } from './ledger.service';
import { OutstandingService } from './outstanding.service';
import { PaymentsService } from './payments.service';
import { TaxNotesService } from './tax-notes.service';

// ── Invoices ────────────────────────────────────────────────────────────────

@ApiTags('Invoices')
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly pdf: InvoicePdfService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.INVOICE_READ)
  @ApiOperation({
    summary: 'List tax invoices',
    description:
      'Scoped by distributor or customer territory. `overdueOnly` is computed from the due ' +
      'date at read time — there is no OVERDUE status, so the answer is never stale.',
  })
  async list(@Query(zodQuery(listInvoicesQuerySchema)) query: ListInvoicesQuery) {
    return this.invoices.list(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.INVOICE_READ)
  @ApiOperation({ summary: 'Invoice detail — lines, settlements, and any tax notes against it' })
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.invoices.findDetail(id);
  }

  @Get(':id/pdf')
  @RequirePermission(PERMISSIONS.INVOICE_READ)
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({
    summary: 'Download the tax invoice',
    description:
      'A DRAFT renders with a DRAFT watermark and no number — a document that looks like a tax ' +
      'invoice but carries no valid number is a compliance problem for whoever receives it.',
  })
  async downloadPdf(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.pdf.render(id);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Content-Length', buffer.length);
    response.end(buffer);
  }

  @Post()
  @RequirePermission(PERMISSIONS.INVOICE_CREATE)
  @ApiOperation({
    summary: 'Draft a direct invoice, with no originating order',
    description:
      'The only invoicing path that calls the pricing engine. An order-derived invoice copies ' +
      'the order’s snapshot instead (ADR-0011).',
  })
  async create(
    @Body(zodBody(createInvoiceSchema)) dto: CreateInvoiceDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.invoices.create(dto, actorId);
  }

  @Post('from-order/:orderId')
  @RequirePermission(PERMISSIONS.INVOICE_CREATE)
  @ApiOperation({
    summary: 'Draft an invoice from an order',
    description:
      'Bills everything not yet invoiced by default; pass `lines` to bill part. Refused for a ' +
      'SECONDARY order — a sell-out is the distributor’s own sale (ADR-0014 §6).',
  })
  async fromOrder(
    @Param('orderId', zodParam(uuidSchema)) orderId: string,
    @Body(zodBody(createInvoiceFromOrderSchema)) dto: CreateInvoiceFromOrderDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.invoices.createFromOrder(orderId, dto, actorId);
  }

  @Post('from-shipment/:shipmentId')
  @RequirePermission(PERMISSIONS.INVOICE_CREATE)
  @ApiOperation({ summary: 'Draft an invoice for exactly what one shipment carried' })
  async fromShipment(
    @Param('shipmentId', zodParam(uuidSchema)) shipmentId: string,
    @Body(zodBody(createInvoiceFromShipmentSchema)) dto: CreateInvoiceFromOrderDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.invoices.createFromShipment(shipmentId, dto, actorId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.INVOICE_CREATE)
  @ApiOperation({ summary: 'Edit a DRAFT invoice. An issued one is frozen (ADR-0016).' })
  async update(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(updateInvoiceSchema)) dto: UpdateInvoiceDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.invoices.update(id, dto, actorId);
  }

  /**
   * Deliberately `invoice:issue`, not `invoice:create`.
   *
   * `SEGREGATION_OF_DUTIES` forbids one role holding both, because issuing is
   * what consumes a statutory number and drafting must not.
   */
  @Post(':id/issue')
  @RequirePermission(PERMISSIONS.INVOICE_ISSUE)
  @ApiOperation({
    summary: 'Issue — allocates the statutory number and posts to the ledger',
    description:
      'Seven refusals, in one transaction (docs/23 §5.1): the company’s statutory identity must ' +
      'be verified, the order must not be SECONDARY, every line’s GST rate must come from the ' +
      'tax table rather than a product snapshot, a supplied GSTIN must checksum, the invoice ' +
      'must have value, and it must not be future-dated.',
  })
  async issue(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(issueInvoiceSchema)) dto: { invoiceDate?: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.invoices.issue(id, dto.invoiceDate, actorId);
  }

  @Post(':id/cancel')
  @RequirePermission(PERMISSIONS.INVOICE_CANCEL)
  @ApiOperation({
    summary: 'Cancel an issued invoice — narrow by design',
    description:
      'Permitted only with no payments, no tax notes, and within the financial year of issue. ' +
      'The number is retained and still reported in GSTR-1 table 13.',
  })
  async cancel(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(cancelInvoiceSchema)) dto: { reason: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.invoices.cancel(id, dto.reason, actorId);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.INVOICE_CREATE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a DRAFT invoice — it consumed no statutory number' })
  async remove(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.invoices.remove(id, actorId);
  }
}

// ── Credit notes ────────────────────────────────────────────────────────────

/**
 * Credit and debit notes get separate routes over ONE service (ADR-0017).
 *
 * The type is fixed by the route rather than accepted in the body, so a client
 * cannot choose which gapless series it consumes and no request is ambiguous.
 */
@ApiTags('Credit notes')
@Controller('credit-notes')
export class CreditNotesController {
  constructor(private readonly notes: TaxNotesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.INVOICE_READ)
  async list(@Query(zodQuery(listTaxNotesQuerySchema)) query: ListTaxNotesQuery) {
    return this.notes.list('CREDIT', query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.INVOICE_READ)
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.notes.findDetail('CREDIT', id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.INVOICE_CREDIT_NOTE)
  @ApiOperation({
    summary: 'Draft a credit note against an issued invoice',
    description:
      'Each line’s tax rate is copied from the invoice line it corrects — the rate that applies ' +
      'to a correction is the rate that applied to the supply. Refused if it would credit more ' +
      'than remains on the invoice.',
  })
  async create(
    @Body(zodBody(createTaxNoteSchema)) dto: CreateTaxNoteDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.notes.create('CREDIT', dto, actorId);
  }

  @Post(':id/issue')
  @RequirePermission(PERMISSIONS.INVOICE_CREDIT_NOTE)
  async issue(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(issueTaxNoteSchema)) dto: { noteDate?: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.notes.issue('CREDIT', id, dto.noteDate, actorId);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.INVOICE_CREDIT_NOTE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.notes.remove('CREDIT', id, actorId);
  }
}

@ApiTags('Debit notes')
@Controller('debit-notes')
export class DebitNotesController {
  constructor(private readonly notes: TaxNotesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.INVOICE_READ)
  async list(@Query(zodQuery(listTaxNotesQuerySchema)) query: ListTaxNotesQuery) {
    return this.notes.list('DEBIT', query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.INVOICE_READ)
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.notes.findDetail('DEBIT', id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.INVOICE_CREDIT_NOTE)
  @ApiOperation({ summary: 'Draft a debit note — an under-charge on an issued invoice' })
  async create(
    @Body(zodBody(createTaxNoteSchema)) dto: CreateTaxNoteDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.notes.create('DEBIT', dto, actorId);
  }

  @Post(':id/issue')
  @RequirePermission(PERMISSIONS.INVOICE_CREDIT_NOTE)
  async issue(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(issueTaxNoteSchema)) dto: { noteDate?: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.notes.issue('DEBIT', id, dto.noteDate, actorId);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.INVOICE_CREDIT_NOTE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.notes.remove('DEBIT', id, actorId);
  }
}

// ── Payments ────────────────────────────────────────────────────────────────

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.PAYMENT_READ)
  async list(@Query(zodQuery(listPaymentsQuerySchema)) query: ListPaymentsQuery) {
    return this.payments.list(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.PAYMENT_READ)
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.payments.findDetail(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.PAYMENT_CREATE)
  @ApiOperation({
    summary: 'Record a receipt — a memo, with NO financial effect',
    description:
      'Recording writes no ledger entry and settles no invoice. Verification does both ' +
      '(ADR-0018). An unverified claim must not be able to reduce a receivable or free up credit.',
  })
  async create(
    @Body(zodBody(createPaymentSchema)) dto: CreatePaymentDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.payments.create(dto, actorId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.PAYMENT_UPDATE)
  @ApiOperation({ summary: 'Edit a RECORDED receipt. A verified one is frozen.' })
  async update(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(updatePaymentSchema)) dto: UpdatePaymentDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.payments.update(id, dto, actorId);
  }

  @Post(':id/verify')
  @RequirePermission(PERMISSIONS.PAYMENT_VERIFY)
  @ApiOperation({
    summary: 'Verify — the financial event',
    description:
      'Credits the ledger (cash and TDS separately) and unlocks allocation. Refused when the ' +
      'verifier is the person who recorded it — the role-level segregation rule cannot stop one ' +
      'PERSON holding two roles.',
  })
  async verify(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(verifyPaymentSchema)) dto: VerifyPaymentDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.payments.verify(id, dto, actorId);
  }

  @Post(':id/allocate')
  @RequirePermission(PERMISSIONS.PAYMENT_ALLOCATE)
  @ApiOperation({
    summary: 'Apply a VERIFIED receipt across invoices',
    description:
      'Takes SELECT … FOR UPDATE on the payment row before reading the unallocated amount — two ' +
      'concurrent allocations is a real race, and check-then-write loses it.',
  })
  async allocate(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(allocatePaymentSchema)) dto: AllocatePaymentDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.payments.allocate(id, dto, actorId);
  }

  @Delete(':id/allocations/:allocationId')
  @RequirePermission(PERMISSIONS.PAYMENT_ALLOCATE)
  @ApiOperation({ summary: 'Un-apply an allocation, returning the debt to the invoice' })
  async removeAllocation(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Param('allocationId', zodParam(uuidSchema)) allocationId: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.payments.removeAllocation(id, allocationId, actorId);
  }

  @Post(':id/bounce')
  @RequirePermission(PERMISSIONS.PAYMENT_VERIFY)
  @ApiOperation({
    summary: 'A cheque that did not clear',
    description:
      'Contra-posts the ledger entries and reverses every allocation. The originals stay — a ' +
      'bounced payment is a thing that happened, and the ledger is append-only.',
  })
  async bounce(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(bouncePaymentSchema)) dto: { reason: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.payments.bounce(id, dto.reason, actorId);
  }
}

// ── Ledger, outstanding, and GST returns ────────────────────────────────────

@ApiTags('Ledger')
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get(':partyType/:partyId')
  @RequirePermission(PERMISSIONS.PAYMENT_READ)
  @ApiOperation({
    summary: 'Statement of account with a running balance',
    description:
      'The running balance accumulates over the WHOLE ledger, not the page — a balance that ' +
      'restarts each page looks authoritative and is wrong. DEBIT increases what the party owes.',
  })
  async statement(
    @Param('partyType', zodParam(ledgerPartyTypeSchema)) partyType: LedgerPartyType,
    @Param('partyId', zodParam(uuidSchema)) partyId: string,
    @Query(zodQuery(listPartyLedgerQuerySchema)) query: ListPartyLedgerQuery,
  ) {
    return this.ledger.statement(partyType, partyId, query);
  }

  @Post('write-off')
  @RequirePermission(PERMISSIONS.PAYMENT_DELETE)
  @ApiOperation({
    summary: 'Write off a balance that will not be collected',
    description:
      'A ledger act, not a payment — no money arrived, and recording it as a receipt would ' +
      'overstate cash. The reason is mandatory and audited. Above ' +
      'finance.writeOffApprovalThreshold a second authoriser is required, who may not be the ' +
      'requester and must actually hold the authority.',
  })
  async writeOff(
    @Body(zodBody(writeOffSchema)) dto: WriteOffDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.ledger.writeOff({ ...dto, actorId });
  }

  @Post('adjust')
  @RequirePermission(PERMISSIONS.PAYMENT_DELETE)
  @ApiOperation({
    summary: 'A manual adjustment, or an opening balance from a prior system',
    description:
      '`amount` is signed here: positive debits (they owe more), negative credits. This is the ' +
      'one entry type whose direction is the operator’s decision rather than implied by a document.',
  })
  async adjust(
    @Body(zodBody(ledgerAdjustmentSchema)) dto: LedgerAdjustmentDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.ledger.adjust({ ...dto, actorId });
  }
}

@ApiTags('Outstanding')
@Controller('outstanding')
export class OutstandingController {
  constructor(private readonly outstanding: OutstandingService) {}

  @Get()
  @RequirePermission(PERMISSIONS.PAYMENT_READ)
  @ApiOperation({
    summary: 'Aging report — 0–30 / 31–60 / 61–90 / 90+',
    description:
      'Aged from the DUE date, not the invoice date: an invoice on Net 45 terms is not overdue ' +
      'on day 31. Sorted worst first, because the report exists to drive a collections call.',
  })
  async report(@Query(zodQuery(listOutstandingQuerySchema)) query: ListOutstandingQuery) {
    return this.outstanding.report(query);
  }

  @Get(':partyType/:partyId')
  @RequirePermission(PERMISSIONS.PAYMENT_READ)
  @ApiOperation({ summary: 'The invoices behind one party’s balance, oldest first' })
  async forParty(
    @Param('partyType', zodParam(ledgerPartyTypeSchema)) partyType: LedgerPartyType,
    @Param('partyId', zodParam(uuidSchema)) partyId: string,
    @Query('asOf') asOf?: string,
  ) {
    return this.outstanding.invoicesFor(partyType, partyId, asOf);
  }
}

@ApiTags('GST returns')
@Controller('gst')
export class GstReturnsController {
  constructor(private readonly returns: GstReturnsService) {}

  @Get('gstr1')
  @RequirePermission(PERMISSIONS.INVOICE_EXPORT)
  @ApiOperation({
    summary: 'GSTR-1 for a period, in the portal’s JSON shape',
    description:
      'Tables 4 (B2B), 5 (B2CL), 7 (B2CS), 9B (CDNR), 12 (HSN) and 13 (documents issued). ' +
      'Cancelled invoices appear only in table 13, retaining their numbers. Invoices derived ' +
      'from SECONDARY orders are excluded entirely, and the count of exclusions is reported.',
  })
  async gstr1(@Query(zodQuery(gstReturnQuerySchema)) query: GstReturnQuery) {
    return this.returns.gstr1(query);
  }

  @Get('gstr3b')
  @RequirePermission(PERMISSIONS.INVOICE_EXPORT)
  @ApiOperation({
    summary: 'GSTR-3B summary for a period',
    description:
      'Outward supplies only, net of credit and debit notes. Table 4 (input tax credit) is ' +
      'returned as zeros with an explicit note — this system holds no purchase documents, and ' +
      'an absent ITC section reads as "nothing to claim".',
  })
  async gstr3b(@Query(zodQuery(gstReturnQuerySchema)) query: GstReturnQuery) {
    return this.returns.gstr3b(query);
  }
}
