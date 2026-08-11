import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type ListCitiesQuery, listCitiesQuerySchema } from '@hixaa/contracts';
import { CacheKeys, RedisService } from '../../infrastructure/cache/redis.service';
import { zodQuery } from '../../common/pipes/zod-validation.pipe';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/**
 * Reference-data lookups for address and territory forms.
 *
 * Read-only and unscoped — a state list is not confidential, and every
 * authenticated user filling in an address needs it. Heavily cached: these rows
 * change roughly never, and every form load would otherwise hit Postgres.
 */
@ApiTags('Geography')
@Controller('geography')
export class GeographyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  @Get('states')
  @ApiOperation({
    summary: 'Indian states and union territories with GST codes',
    description:
      'The GST state code drives the place-of-supply rule that decides CGST+SGST versus IGST.',
  })
  async states() {
    return this.redis.remember(
      CacheKeys.systemSettings('geography:states'),
      this.config.cache.referenceTtl,
      () =>
        this.prisma.db.state.findMany({
          where: { isActive: true },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            code: true,
            gstStateCode: true,
            isUnionTerritory: true,
          },
        }),
    );
  }

  @Get('cities')
  @ApiOperation({ summary: 'Cities, optionally filtered by state' })
  async cities(@Query(zodQuery(listCitiesQuerySchema)) query: ListCitiesQuery) {
    const { stateId } = query;
    return this.prisma.db.city.findMany({
      where: { isActive: true, ...(stateId ? { stateId } : {}) },
      orderBy: { name: 'asc' },
      take: 500,
      select: { id: true, name: true, stateId: true, pincode: true },
    });
  }

  @Get('industries')
  @ApiOperation({ summary: 'Industries Hixaa serves' })
  async industries() {
    return this.redis.remember(
      CacheKeys.systemSettings('geography:industries'),
      this.config.cache.referenceTtl,
      () =>
        this.prisma.db.industry.findMany({
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: { id: true, slug: true, name: true, description: true },
        }),
    );
  }

  /**
   * Units of measure.
   *
   * Ten rows have been seeded since Phase 3 with nothing able to read them —
   * `Product.uomId` was settable only through a direct API call, so the field
   * was effectively unreachable from any interface. Lives here beside states
   * and industries because it is the same kind of thing: small, static
   * reference data every catalogue form needs.
   *
   * `uqc` is the GST Unit Quantity Code and travels with the row: it is what a
   * GSTR-1 line must carry, so a form that picks a unit has already picked the
   * code the return will report.
   */
  @Get('uoms')
  @ApiOperation({ summary: 'Units of measure, with their GST Unit Quantity Codes' })
  async uoms() {
    return this.redis.remember(
      CacheKeys.systemSettings('geography:uoms'),
      this.config.cache.referenceTtl,
      () =>
        this.prisma.db.unitOfMeasure.findMany({
          where: { isActive: true },
          orderBy: { code: 'asc' },
          select: { id: true, code: true, name: true, uqc: true, precision: true },
        }),
    );
  }
}
