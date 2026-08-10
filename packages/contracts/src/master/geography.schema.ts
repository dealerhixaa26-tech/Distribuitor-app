import { z } from 'zod';
import { businessCodeSchema, idSchema, shortTextSchema } from '../primitives/common';
import { indianPhoneSchema, pincodeSchema } from '../primitives/india';
import { territoryTypeSchema } from '../enums';

/** Geography, address, territory, and warehouse contracts. */

// ── Address ─────────────────────────────────────────────────────────────────

export const addressSchema = z.object({
  label: z.string().trim().max(60).optional(),
  line1: shortTextSchema,
  line2: z.string().trim().max(200).optional(),
  landmark: z.string().trim().max(120).optional(),
  cityId: idSchema.optional(),
  /**
   * Free text alongside the optional `cityId`. Seeding every Indian city would
   * be tens of thousands of rows of noise, and a distributor in a town we have
   * not listed must still be enterable.
   */
  cityName: shortTextSchema,
  stateId: idSchema,
  postalCode: pincodeSchema,
  countryCode: z.string().length(2).default('IN'),
  contactName: z.string().trim().max(120).optional(),
  contactPhone: indianPhoneSchema.optional(),
});
export type AddressDto = z.infer<typeof addressSchema>;

// ── Territory ───────────────────────────────────────────────────────────────

export const createTerritorySchema = z.object({
  code: businessCodeSchema,
  name: shortTextSchema,
  type: territoryTypeSchema.default('REGION'),
  parentId: idSchema.nullable().optional(),
  stateId: idSchema.nullable().optional(),
  managerId: idSchema.nullable().optional(),
  description: z.string().trim().max(500).optional(),
});
export type CreateTerritoryDto = z.infer<typeof createTerritorySchema>;

export const updateTerritorySchema = createTerritorySchema.partial().omit({ code: true });
export type UpdateTerritoryDto = z.infer<typeof updateTerritorySchema>;

/** Moving a subtree is a distinct, riskier operation than editing a name. */
export const moveTerritorySchema = z.object({
  parentId: idSchema.nullable(),
});

export const territorySchema = z.object({
  id: idSchema,
  code: z.string(),
  name: z.string(),
  type: territoryTypeSchema,
  parentId: idSchema.nullable(),
  path: z.string(),
  depth: z.number().int(),
  stateId: idSchema.nullable(),
  stateName: z.string().nullable(),
  gstStateCode: z.string().nullable(),
  managerId: idSchema.nullable(),
  managerName: z.string().nullable(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  childCount: z.number().int().nonnegative(),
});
export type TerritorySummary = z.infer<typeof territorySchema>;

/** A node with its descendants nested, for the tree view. */
export type TerritoryNode = TerritorySummary & { children: TerritoryNode[] };

// ── Warehouse ───────────────────────────────────────────────────────────────
//
// MOVED to `inventory/warehouse.schema.ts` in Phase 6, which owns warehouses
// (roadmap 6.1). The stub that lived here was introduced in Phase 3 alongside
// the Warehouse model because a warehouse is a location; it had no
// type/distributor cross-validation, which Phase 6 requires — a DISTRIBUTOR
// warehouse must name its owner and no other type may. Kept as one definition
// rather than two so the two cannot disagree.

// ── Lookups ─────────────────────────────────────────────────────────────────

export const stateSchema = z.object({
  id: idSchema,
  name: z.string(),
  code: z.string(),
  gstStateCode: z.string(),
  isUnionTerritory: z.boolean(),
});

export const citySchema = z.object({
  id: idSchema,
  name: z.string(),
  stateId: idSchema,
  pincode: z.string().nullable(),
});

/**
 * The city lookup's only parameter.
 *
 * It existed as a raw `@Query('stateId')` string handed straight to Prisma, so
 * a malformed id reached the driver and came back as a 500 — the one query
 * parameter in the API with no schema behind it, on the endpoint an address
 * form calls every time someone picks a state. A bad id is the caller's
 * mistake and belongs in a 422; a 500 means something here is broken, and
 * that distinction is what the ops alerting reads.
 */
export const listCitiesQuerySchema = z.object({
  stateId: idSchema.optional(),
});
export type ListCitiesQuery = z.infer<typeof listCitiesQuerySchema>;

export const industrySchema = z.object({
  id: idSchema,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});
