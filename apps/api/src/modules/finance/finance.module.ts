import { Module } from '@nestjs/common';
import { DistributorsModule } from '../distributors/distributors.module';
import { DocumentRendererModule } from '../documents/document-renderer.module';
import { PricingModule } from '../pricing/pricing.module';
import { SalesModule } from '../sales/sales.module';
import {
  CreditNotesController,
  DebitNotesController,
  GstReturnsController,
  InvoicesController,
  LedgerController,
  OutstandingController,
  PaymentsController,
} from './finance.controller';
import { GstReturnsService } from './gst-returns.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoicesService } from './invoices.service';
import { LedgerService } from './ledger.service';
import { OutstandingService } from './outstanding.service';
import { PaymentsService } from './payments.service';
import { TaxNotesService } from './tax-notes.service';

/**
 * Finance — invoicing, notes, payments, the party ledger, and GST returns.
 *
 * The imports are the point, exactly as they were for `SalesModule`. This
 * module CONSUMES:
 *
 *   • `PricingModule` — `quote()` for a direct invoice, and `resolveTaxRate()`
 *     for the issue gate. No second tax lookup lives in here.
 *   • `SalesModule` — `SalesPricingHelper`, so a direct invoice is priced by
 *     the same code as a quotation and an order.
 *   • `DistributorsModule` — `NumberSequenceService`, the gapless allocator,
 *     now serving four financial series.
 *   • `DocumentRendererModule` — the invoice PDF is a sibling of the quotation
 *     (ADR-0013), sharing page setup, fonts, styles and the letterhead.
 *
 * `SettingsModule` is @Global; the company's statutory identity and the payment
 * terms are read from it on the issue path.
 *
 * `OutstandingService` is exported because `OrderApprovalService.checkCredit`
 * needs it: credit exposure gains its outstanding-invoice term in Phase 8, and
 * that term has to come from here rather than from a second query that could
 * disagree about what "outstanding" means.
 */
@Module({
  imports: [PricingModule, SalesModule, DistributorsModule, DocumentRendererModule],
  controllers: [
    InvoicesController,
    CreditNotesController,
    DebitNotesController,
    PaymentsController,
    LedgerController,
    OutstandingController,
    GstReturnsController,
  ],
  providers: [
    LedgerService,
    InvoicesService,
    InvoicePdfService,
    TaxNotesService,
    PaymentsService,
    OutstandingService,
    GstReturnsService,
  ],
  exports: [OutstandingService, LedgerService, InvoicesService],
})
export class FinanceModule {}
