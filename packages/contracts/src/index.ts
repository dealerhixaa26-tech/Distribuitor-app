/**
 * @hixaa/contracts — the single source of truth for every shape crossing a
 * boundary in this system. See ADR-0001.
 *
 * Consumed by:
 *   • NestJS ZodValidationPipe   → runtime request validation
 *   • zod-to-openapi             → the OpenAPI specification
 *   • React Hook Form resolver   → client-side validation, identical rules
 *   • Both apps' TypeScript      → via z.infer
 *
 * A validation rule cannot disagree between client and server because there is
 * only one rule.
 */

export * from './primitives/money';
export * from './primitives/india';
export * from './primitives/indian-number';
export * from './primitives/common';
export * from './primitives/pagination';
export * from './primitives/problem';
export * from './enums';
export * from './permissions';
export * from './events';
export * from './auth/auth.schema';
export * from './auth/user.schema';
export * from './master/geography.schema';
export * from './master/settings.schema';
export * from './channel/distributor.schema';
export * from './catalog/category.schema';
export * from './catalog/product.schema';
export * from './catalog/pricing.schema';
export * from './inventory/warehouse.schema';
export * from './inventory/stock.schema';
export * from './sales/customer.schema';
export * from './sales/order.schema';
