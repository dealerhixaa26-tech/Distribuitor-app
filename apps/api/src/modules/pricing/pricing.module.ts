import { Module } from '@nestjs/common';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';

/**
 * Pricing — the single place a price is decided. See ADR-0007.
 *
 * `PricingService` is exported because Phase 7 (quotations, orders) and Phase 8
 * (invoicing) must call it rather than reimplementing resolution. If a future
 * module reads `PriceListItem.price` directly, a quote and its invoice will
 * eventually disagree and nobody will be able to say which is right.
 *
 * `SettingsService` is not imported here: SettingsModule is @Global, and the
 * supplier's GST state code is read from it on every quote.
 */
@Module({
  controllers: [PricingController],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
