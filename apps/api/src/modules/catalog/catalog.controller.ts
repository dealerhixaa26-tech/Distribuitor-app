import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  addBomComponentSchema,
  attachProductMediaSchema,
  authorizeProductSchema,
  bulkAuthorizeProductsSchema,
  changeProductStatusSchema,
  clonePriceListSchema,
  createCategorySchema,
  createDiscountRuleSchema,
  createPriceListSchema,
  createProductSchema,
  createTaxRateSchema,
  listCategoriesQuerySchema,
  listPriceListsQuerySchema,
  listProductsQuerySchema,
  moveCategorySchema,
  productSpecificationSchema,
  updateCategorySchema,
  updatePriceListSchema,
  updateProductSchema,
  upsertPriceListItemsSchema,
  uuidSchema,
  type AddBomComponentDto,
  type AttachProductMediaDto,
  type AuthorizeProductDto,
  type ClonePriceListDto,
  type CreateCategoryDto,
  type CreateDiscountRuleDto,
  type CreatePriceListDto,
  type CreateProductDto,
  type CreateTaxRateDto,
  type ListCategoriesQuery,
  type ListPriceListsQuery,
  type ListProductsQuery,
  type ProductSpecificationDto,
  type UpdateCategoryDto,
  type UpdatePriceListDto,
  type UpdateProductDto,
} from '@hixaa/contracts';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CategoriesService } from './categories.service';
import { DistributorCatalogService } from './distributor-catalog.service';
import { PriceListsService } from './price-lists.service';
import { PricingRulesService } from './pricing-rules.service';
import { ProductRelationsService } from './product-relations.service';
import { ProductsService } from './products.service';

// ── Categories ──────────────────────────────────────────────────────────────

@ApiTags('Categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.CATEGORY_READ)
  @ApiOperation({ summary: 'List categories, optionally as a subtree' })
  async list(@Query(zodQuery(listCategoriesQuerySchema)) query: ListCategoriesQuery) {
    return this.categories.list(query);
  }

  /** Declared before `:id` so it is not captured as an identifier. */
  @Get('tree')
  @RequirePermission(PERMISSIONS.CATEGORY_READ)
  @ApiOperation({ summary: 'The whole category tree, nested' })
  async tree(@Query('includeInactive') includeInactive?: string) {
    return { data: await this.categories.tree(includeInactive === 'true') };
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CATEGORY_READ)
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.categories.findById(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.CATEGORY_CREATE)
  async create(
    @Body(zodBody(createCategorySchema)) dto: CreateCategoryDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.categories.create(dto, actorId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CATEGORY_UPDATE)
  async update(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(updateCategorySchema)) dto: UpdateCategoryDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.categories.update(id, dto, actorId);
  }

  @Post(':id/move')
  @RequirePermission(PERMISSIONS.CATEGORY_UPDATE)
  @ApiOperation({
    summary: 'Reparent a category',
    description:
      'Its own endpoint because it rewrites every descendant’s materialised path in one ' +
      'transaction. Refused when it would create a cycle.',
  })
  async move(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(moveCategorySchema)) dto: { parentId: string | null },
    @CurrentUser('id') actorId: string,
  ) {
    return this.categories.move(id, dto.parentId, actorId);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.CATEGORY_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.categories.remove(id, actorId);
  }
}

// ── Products ────────────────────────────────────────────────────────────────

@ApiTags('Products')
@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly relations: ProductRelationsService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.PRODUCT_READ)
  @ApiOperation({
    summary: 'List and search products',
    description:
      'With `q`, results are full-text ranked and capped at 200 matches; `meta.truncated` ' +
      'reports when that cap was reached. Without `q`, the list is keyset-paginated.',
  })
  async list(@Query(zodQuery(listProductsQuerySchema)) query: ListProductsQuery) {
    return this.products.list(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.PRODUCT_READ)
  @ApiOperation({ summary: 'Product detail — specifications, media, BOM, variants, prices' })
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.products.findDetail(id);
  }

  @Get(':id/revisions')
  @RequirePermission(PERMISSIONS.PRODUCT_READ)
  @ApiOperation({
    summary: 'Revision history',
    description: 'What the product looked like when an earlier quotation was raised against it.',
  })
  async revisions(@Param('id', zodParam(uuidSchema)) id: string) {
    return { data: await this.products.revisions(id) };
  }

  @Get(':id/bom/explode')
  @RequirePermission(PERMISSIONS.PRODUCT_READ)
  @ApiOperation({
    summary: 'Explode a kit into its components',
    description:
      'Recursive, cycle-guarded, and depth-limited. Quantities are multiplied down the tree, ' +
      'so a 50-worker Raksha deployment resolves to the actual gateway and tag counts.',
  })
  async explode(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Query('quantity') quantity?: string,
  ) {
    return { data: await this.relations.explode(id, quantity ?? '1') };
  }

  @Post()
  @RequirePermission(PERMISSIONS.PRODUCT_CREATE)
  @ApiOperation({
    summary: 'Create a product',
    description:
      'Always starts as DRAFT. Activation is the gate where an HSN or SAC code stops being ' +
      'optional, because an ACTIVE product can reach a quotation and then an invoice.',
  })
  async create(
    @Body(zodBody(createProductSchema)) dto: CreateProductDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.products.create(dto, actorId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.PRODUCT_UPDATE)
  async update(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(updateProductSchema)) dto: UpdateProductDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.products.update(id, dto, actorId);
  }

  @Post(':id/status')
  @RequirePermission(PERMISSIONS.PRODUCT_UPDATE)
  @ApiOperation({ summary: 'Move a product through its lifecycle' })
  async changeStatus(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(changeProductStatusSchema)) dto: { status: string; reason?: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.products.changeStatus(id, dto.status as never, dto.reason, actorId);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.PRODUCT_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.products.remove(id, actorId);
  }

  // ── Specifications ────────────────────────────────────────────────────────

  @Post(':id/specifications')
  @RequirePermission(PERMISSIONS.PRODUCT_UPDATE)
  async addSpecification(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(productSpecificationSchema)) dto: ProductSpecificationDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.relations.addSpecification(id, dto, actorId);
  }

  @Put(':id/specifications')
  @RequirePermission(PERMISSIONS.PRODUCT_UPDATE)
  @ApiOperation({ summary: 'Replace the whole specification sheet' })
  async replaceSpecifications(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(productSpecificationSchema.array().max(200)))
    specs: ProductSpecificationDto[],
    @CurrentUser('id') actorId: string,
  ) {
    return { data: await this.relations.replaceSpecifications(id, specs, actorId) };
  }

  @Delete(':id/specifications/:specificationId')
  @RequirePermission(PERMISSIONS.PRODUCT_UPDATE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeSpecification(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Param('specificationId', zodParam(uuidSchema)) specificationId: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.relations.removeSpecification(id, specificationId, actorId);
  }

  // ── Media ─────────────────────────────────────────────────────────────────

  @Post(':id/media')
  @RequirePermission(PERMISSIONS.PRODUCT_MEDIA_MANAGE)
  @ApiOperation({
    summary: 'Attach an uploaded document as product media',
    description:
      'Takes a documentId rather than a file: upload, virus scanning, and storage belong to ' +
      'DocumentsService, and a second upload path would be a second way an unscanned file ' +
      'could reach a user.',
  })
  async attachMedia(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(attachProductMediaSchema)) dto: AttachProductMediaDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.relations.attachMedia(id, dto, actorId);
  }

  @Delete(':id/media/:mediaId')
  @RequirePermission(PERMISSIONS.PRODUCT_MEDIA_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMedia(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Param('mediaId', zodParam(uuidSchema)) mediaId: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.relations.removeMedia(id, mediaId, actorId);
  }

  // ── Bill of materials ─────────────────────────────────────────────────────

  @Post(':id/bom')
  @RequirePermission(PERMISSIONS.PRODUCT_UPDATE)
  @ApiOperation({ summary: 'Add a component to a kit' })
  async addBomComponent(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(addBomComponentSchema)) dto: AddBomComponentDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.relations.addBomComponent(id, dto, actorId);
  }

  @Delete(':id/bom/:componentId')
  @RequirePermission(PERMISSIONS.PRODUCT_UPDATE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeBomComponent(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Param('componentId', zodParam(uuidSchema)) componentId: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.relations.removeBomComponent(id, componentId, actorId);
  }
}

// ── Price lists ─────────────────────────────────────────────────────────────

@ApiTags('Price lists')
@Controller('price-lists')
export class PriceListsController {
  constructor(private readonly priceLists: PriceListsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.PRICELIST_READ)
  async list(@Query(zodQuery(listPriceListsQuerySchema)) query: ListPriceListsQuery) {
    return this.priceLists.list(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.PRICELIST_READ)
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.priceLists.findById(id);
  }

  @Get(':id/items')
  @RequirePermission(PERMISSIONS.PRICELIST_READ)
  @ApiOperation({ summary: 'Price points, including every volume slab. Prices exclude GST.' })
  async items(@Param('id', zodParam(uuidSchema)) id: string) {
    return { data: await this.priceLists.items(id) };
  }

  @Post()
  @RequirePermission(PERMISSIONS.PRICELIST_CREATE)
  async create(
    @Body(zodBody(createPriceListSchema)) dto: CreatePriceListDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.priceLists.create(dto, actorId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.PRICELIST_UPDATE)
  async update(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(updatePriceListSchema)) dto: UpdatePriceListDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.priceLists.update(id, dto, actorId);
  }

  @Put(':id/items')
  @RequirePermission(PERMISSIONS.PRICELIST_UPDATE)
  @ApiOperation({
    summary: 'Bulk upsert price points',
    description: 'One transaction — a half-applied price list is worse than an unchanged one.',
  })
  async upsertItems(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(upsertPriceListItemsSchema))
    dto: { items: Array<{ productId: string; variantId?: string; minQty: string; price: string; minPrice?: string }>; replaceAll: boolean },
    @CurrentUser('id') actorId: string,
  ) {
    return this.priceLists.upsertItems(id, dto.items, dto.replaceAll, actorId);
  }

  @Post(':id/clone')
  @RequirePermission(PERMISSIONS.PRICELIST_CREATE)
  @ApiOperation({
    summary: 'Clone into a new DRAFT version',
    description:
      'How a price revision happens. The live list keeps serving orders under negotiation ' +
      'while the new version is prepared. `adjustPercent` applies a blanket uplift.',
  })
  async clone(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(clonePriceListSchema)) dto: ClonePriceListDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.priceLists.clone(id, dto, actorId);
  }

  @Post(':id/publish')
  @RequirePermission(PERMISSIONS.PRICELIST_PUBLISH)
  @ApiOperation({
    summary: 'Publish a draft list (DRAFT → ACTIVE)',
    description:
      'Its own permission: whoever assembles a price list should not necessarily be the ' +
      'person who commits the company to it. Refused when the list is empty.',
  })
  async publish(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.priceLists.publish(id, actorId);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.PRICELIST_UPDATE)
  async archive(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.priceLists.archive(id, actorId);
  }
}

// ── Discount rules & tax rates ──────────────────────────────────────────────

@ApiTags('Discount rules')
@Controller('discount-rules')
export class DiscountRulesController {
  constructor(private readonly rules: PricingRulesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.DISCOUNT_READ)
  async list(
    @Query('scope') scope?: string,
    @Query('targetId') targetId?: string,
    @Query('isActive') isActive?: string,
    @Query('activeOn') activeOn?: string,
  ) {
    return this.rules.listDiscountRules({
      scope,
      targetId,
      isActive: isActive === undefined ? undefined : isActive === 'true',
      activeOn,
    });
  }

  @Post()
  @RequirePermission(PERMISSIONS.DISCOUNT_CREATE)
  @ApiOperation({
    summary: 'Create a discount rule',
    description:
      'Rules do not stack: the highest priority wins and the rest are reported in the quote ' +
      'trace as considered-and-rejected. See ADR-0007 §3.',
  })
  async create(
    @Body(zodBody(createDiscountRuleSchema)) dto: CreateDiscountRuleDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.rules.createDiscountRule(dto, actorId);
  }

  @Post(':id/activate')
  @RequirePermission(PERMISSIONS.DISCOUNT_APPROVE)
  async activate(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.rules.setDiscountRuleActive(id, true, actorId);
  }

  @Post(':id/deactivate')
  @RequirePermission(PERMISSIONS.DISCOUNT_APPROVE)
  async deactivate(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.rules.setDiscountRuleActive(id, false, actorId);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.DISCOUNT_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.rules.removeDiscountRule(id, actorId);
  }
}

@ApiTags('Tax rates')
@Controller('tax-rates')
export class TaxRatesController {
  constructor(private readonly rules: PricingRulesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.PRODUCT_READ)
  async list(
    @Query('hsnSacCode') hsnSacCode?: string,
    @Query('effectiveOn') effectiveOn?: string,
  ) {
    return this.rules.listTaxRates({ hsnSacCode, effectiveOn });
  }

  @Post()
  @RequirePermission(PERMISSIONS.SETTING_UPDATE)
  @ApiOperation({
    summary: 'Record a GST rate',
    description:
      'A rate is never edited — this INSERTS a new row and closes the previous one’s ' +
      'effective range. Historical invoices keep resolving their historical rate, which is ' +
      'what makes them reproducible years later (ADR-0008).',
  })
  async create(
    @Body(zodBody(createTaxRateSchema)) dto: CreateTaxRateDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.rules.createTaxRate(dto, actorId);
  }
}

// ── Authorized catalog (scoped) ─────────────────────────────────────────────

@ApiTags('Distributors')
@Controller('distributors/:distributorId/products')
export class DistributorCatalogController {
  constructor(private readonly catalog: DistributorCatalogService) {}

  @Get()
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_READ)
  @ApiOperation({
    summary: 'The distributor’s authorized catalog',
    description:
      'Scoped: a territory-scoped caller asking about a distributor outside their subtree ' +
      'receives 404, not 403 — a 403 would confirm the record exists.',
  })
  async list(
    @Param('distributorId', zodParam(uuidSchema)) distributorId: string,
    @Query('q') q?: string,
    @Query('isActive') isActive?: string,
  ) {
    return this.catalog.list(distributorId, {
      q,
      isActive: isActive === undefined ? undefined : isActive === 'true',
    });
  }

  @Post()
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_UPDATE)
  @ApiOperation({ summary: 'Authorize a product for this distributor' })
  async authorize(
    @Param('distributorId', zodParam(uuidSchema)) distributorId: string,
    @Body(zodBody(authorizeProductSchema)) dto: AuthorizeProductDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.catalog.authorize(distributorId, dto, actorId);
  }

  @Post('bulk')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_UPDATE)
  @ApiOperation({ summary: 'Authorize many products at once' })
  async authorizeMany(
    @Param('distributorId', zodParam(uuidSchema)) distributorId: string,
    @Body(zodBody(bulkAuthorizeProductsSchema))
    dto: { productIds: string[]; customPriceListId?: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.catalog.authorizeMany(
      distributorId,
      dto.productIds,
      dto.customPriceListId,
      actorId,
    );
  }

  @Delete(':productId')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_UPDATE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param('distributorId', zodParam(uuidSchema)) distributorId: string,
    @Param('productId', zodParam(uuidSchema)) productId: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.catalog.revoke(distributorId, productId, actorId);
  }
}
