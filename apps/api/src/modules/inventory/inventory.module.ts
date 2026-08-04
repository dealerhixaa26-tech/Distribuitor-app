import { Module } from '@nestjs/common';
import { DistributorsModule } from '../distributors/distributors.module';
import { InventoryController, WarehousesController } from './inventory.controller';
import { InventorySettingsService } from './inventory-settings.service';
import { ReconciliationService } from './reconciliation.service';
import { ReservationsService } from './reservations.service';
import { SerialsService } from './serials.service';
import { StockLedgerService } from './stock-ledger.service';
import { StockService } from './stock.service';
import { WarehousesService } from './warehouses.service';

/**
 * Inventory — a ledger plus a derived balance. See ADR-0002.
 *
 * `StockLedgerService` is exported because Phase 7 must reserve on order
 * approval and consume on dispatch, and Phase 8 needs cost of goods sold. It is
 * the ONLY sanctioned way to write stock: a second write path would be a second
 * place for the row lock to be forgotten, and that failure is silent.
 *
 * `DistributorsModule` is imported for `NumberSequenceService`, which allocates
 * gapless transfer codes — the same allocator Phase 8 will use for statutory
 * invoice numbers.
 */
@Module({
  imports: [DistributorsModule],
  controllers: [WarehousesController, InventoryController],
  providers: [
    WarehousesService,
    StockLedgerService,
    StockService,
    ReservationsService,
    SerialsService,
    InventorySettingsService,
    ReconciliationService,
  ],
  exports: [
    StockLedgerService,
    StockService,
    ReservationsService,
    SerialsService,
    ReconciliationService,
    // Phase 7 provisions a DISTRIBUTOR channel warehouse on first dispatch
    // (ADR-0014 §1), so the sales module needs this one too.
    WarehousesService,
  ],
})
export class InventoryModule {}
