import { Module } from '@nestjs/common';
import { DistributorsModule } from '../distributors/distributors.module';
import { DocumentRendererModule } from '../documents/document-renderer.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PricingModule } from '../pricing/pricing.module';
import { CustomersService } from './customers.service';
import { OrderApprovalService } from './order-approval.service';
import { OrdersService } from './orders.service';
import { QuotationPdfService } from './quotation-pdf.service';
import { QuotationsService } from './quotations.service';
import { SalesPricingHelper } from './sales-pricing.helper';
import {
  CustomersController,
  OrdersController,
  QuotationsController,
  ShipmentsController,
} from './sales.controller';
import { ShipmentsService } from './shipments.service';

/**
 * Sales — where the pricing engine and the stock ledger meet.
 *
 * The imports are the point: this module CONSUMES `PricingModule` and
 * `InventoryModule` rather than reimplementing either. If a future contributor
 * finds themselves reading `PriceListItem.price` or writing `stock_balance`
 * from in here, that is the bug ADR-0007 and ADR-0002 were written to prevent.
 *
 * `DistributorsModule` supplies `NumberSequenceService` — the gapless allocator
 * that Phase 8's statutory invoice series will use unchanged.
 */
@Module({
  imports: [PricingModule, InventoryModule, DistributorsModule, DocumentRendererModule],
  controllers: [
    CustomersController,
    QuotationsController,
    OrdersController,
    ShipmentsController,
  ],
  providers: [
    CustomersService,
    SalesPricingHelper,
    QuotationsService,
    QuotationPdfService,
    OrderApprovalService,
    OrdersService,
    ShipmentsService,
  ],
  // Exported for Phase 8: invoicing reads an order's snapshotted lines, and a
  // DIRECT invoice (one with no originating order) prices through
  // `SalesPricingHelper` — the same helper a quotation and an order use, so
  // there is exactly one mapping from the pricing engine onto stored line
  // columns rather than a third one living in the finance module.
  exports: [OrdersService, OrderApprovalService, QuotationsService, SalesPricingHelper],
})
export class SalesModule {}
