import { z } from 'zod';
import {
  businessCodeSchema,
  dateTimeSchema,
  idSchema,
  mediumTextSchema,
  shortTextSchema,
} from '../primitives/common';
import { cursorPaginationSchema } from '../primitives/pagination';
import { warehouseTypeSchema } from '../enums';
import { addressSchema } from '../master/geography.schema';

/**
 * Warehouse contracts.
 *
 * The type rule is enforced here, in the service, and as a CHECK constraint in
 * migration 0007: a DISTRIBUTOR warehouse names a distributor, and every other
 * type does not. Mixing them up would let a partner's stock be counted as
 * Hixaa's own — an inventory valuation error, not a display glitch.
 */

const warehouseBaseSchema = z.object({
  code: businessCodeSchema,
  name: shortTextSchema,
  type: warehouseTypeSchema.default('COMPANY'),
  distributorId: idSchema.optional(),
  territoryId: idSchema.optional(),
  address: addressSchema.optional(),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  notes: mediumTextSchema.optional(),
});

const assertDistributorMatchesType = (
  value: { type?: string; distributorId?: string },
  ctx: z.RefinementCtx,
): void => {
  if (value.type === 'DISTRIBUTOR' && !value.distributorId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['distributorId'],
      message: 'A distributor warehouse must name the distributor that owns it',
    });
  }
  if (value.type && value.type !== 'DISTRIBUTOR' && value.distributorId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['distributorId'],
      message: `A ${value.type} warehouse is Hixaa's own and cannot belong to a distributor`,
    });
  }
};

export const createWarehouseSchema = warehouseBaseSchema.superRefine(assertDistributorMatchesType);
export type CreateWarehouseDto = z.infer<typeof createWarehouseSchema>;

export const updateWarehouseSchema = warehouseBaseSchema
  .partial()
  // Type and owner are structural. Changing either would reassign existing
  // stock between Hixaa's books and a partner's, so it is not a PATCH.
  .omit({ code: true, type: true, distributorId: true });
export type UpdateWarehouseDto = z.infer<typeof updateWarehouseSchema>;

export const listWarehousesQuerySchema = cursorPaginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  type: warehouseTypeSchema.optional(),
  territoryId: idSchema.optional(),
  distributorId: idSchema.optional(),
  isActive: z.coerce.boolean().optional(),
});
export type ListWarehousesQuery = z.infer<typeof listWarehousesQuerySchema>;

export const warehouseSummarySchema = z.object({
  id: idSchema,
  code: z.string(),
  name: z.string(),
  type: warehouseTypeSchema,
  distributorId: idSchema.nullable(),
  distributorName: z.string().nullable(),
  territoryId: idSchema.nullable(),
  territoryName: z.string().nullable(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  /** Distinct products holding stock here. */
  stockedProductCount: z.number().int().nonnegative(),
  createdAt: dateTimeSchema,
});

export type WarehouseSummary = z.infer<typeof warehouseSummarySchema>;
