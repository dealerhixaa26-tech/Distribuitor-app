import { Module } from '@nestjs/common';
import {
  CategoriesController,
  DiscountRulesController,
  DistributorCatalogController,
  PriceListsController,
  ProductsController,
  TaxRatesController,
} from './catalog.controller';
import { CategoriesService } from './categories.service';
import { DistributorCatalogService } from './distributor-catalog.service';
import { PriceListsService } from './price-lists.service';
import { PricingRulesService } from './pricing-rules.service';
import { ProductRelationsService } from './product-relations.service';
import { ProductsService } from './products.service';

/**
 * Catalog — categories, products, price lists, discount rules, tax rates, and
 * the distributor authorized catalog.
 *
 * The pricing ENGINE deliberately lives in its own module (`PricingModule`), not
 * here. Catalog owns the data; pricing owns the one algorithm that reads it.
 * Keeping them apart is what stops a future contributor from adding a second
 * price-resolution path next to the tables — see ADR-0007.
 *
 * `ProductRelationsService` is exported because Phase 6 reserves stock against
 * an exploded bill of materials and Phase 7 prices one.
 */
@Module({
  controllers: [
    CategoriesController,
    ProductsController,
    PriceListsController,
    DiscountRulesController,
    TaxRatesController,
    DistributorCatalogController,
  ],
  providers: [
    CategoriesService,
    ProductsService,
    ProductRelationsService,
    PriceListsService,
    PricingRulesService,
    DistributorCatalogService,
  ],
  exports: [ProductsService, ProductRelationsService, PriceListsService, DistributorCatalogService],
})
export class CatalogModule {}
