import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, quoteRequestSchema, type QuoteRequest } from '@hixaa/contracts';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { PricingService } from './pricing.service';

@ApiTags('Pricing')
@Controller('pricing')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  /**
   * A POST despite being a pure read: the request is a structured document —
   * a basket of lines with quantities, a distributor, a date, a place of
   * supply — not something that belongs in a query string. Nothing is written.
   */
  @Post('quote')
  @RequirePermission(PERMISSIONS.PRICELIST_READ)
  @ApiOperation({
    summary: 'Resolve prices, discounts, and GST for a basket',
    description:
      'The single pricing entry point (ADR-0007). Quotations, orders, and invoicing all call ' +
      'this rather than reading price-list rows directly, so a quote and the invoice it ' +
      'becomes cannot disagree. Returns a per-line trace showing which price list was used ' +
      'and why, which volume slab matched, which discount rule won and which lost, and how ' +
      'the GST split was decided. Manual overrides are accepted with a mandatory reason and ' +
      'flagged when they exceed the caller’s ceiling — flagged, never refused: enforcement ' +
      'belongs to order approval, which is what can actually block a commitment.',
  })
  async quote(
    @Body(zodBody(quoteRequestSchema)) request: QuoteRequest,
    @CurrentUser('id') actorId: string,
  ) {
    return this.pricing.quote(request, actorId);
  }
}
