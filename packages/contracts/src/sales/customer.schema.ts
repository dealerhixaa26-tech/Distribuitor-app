import { z } from 'zod';
import {
  businessCodeSchema,
  dateTimeSchema,
  idSchema,
  longTextSchema,
  shortTextSchema,
  tagsSchema,
  urlSchema,
} from '../primitives/common';
import { gstinSchema, indianPhoneSchema, panSchema } from '../primitives/india';
import { cursorPaginationSchema } from '../primitives/pagination';
import { customerTypeSchema } from '../enums';
import { addressSchema } from '../master/geography.schema';

/**
 * Customer contracts.
 *
 * A Customer is an END customer — a plant, a mine, a government body. Distinct
 * from a Distributor, which is a channel partner. The distinction is what makes
 * sell-in and sell-out separable: a PRIMARY order is Hixaa → distributor, a
 * SECONDARY order is distributor → customer.
 *
 * Statutory identifiers reuse the same validators as Distributor, so a
 * customer's GSTIN is held to exactly the standard the company's own is.
 */

export const createCustomerSchema = z.object({
  code: businessCodeSchema.optional(),
  name: shortTextSchema,
  type: customerTypeSchema.default('INDUSTRIAL'),

  distributorId: idSchema.optional(),
  territoryId: idSchema.optional(),
  industryId: idSchema.optional(),

  gstin: gstinSchema.optional(),
  pan: panSchema.optional(),

  billingAddress: addressSchema.optional(),
  shippingAddress: addressSchema.optional(),

  /** The plant or site, where that differs from the billing entity. */
  siteName: shortTextSchema.optional(),
  website: urlSchema.optional().or(z.literal('')),
  notes: longTextSchema.optional(),
  tags: tagsSchema,
  isActive: z.boolean().default(true),
});

export type CreateCustomerDto = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = createCustomerSchema.partial().omit({ code: true });
export type UpdateCustomerDto = z.infer<typeof updateCustomerSchema>;

export const createCustomerContactSchema = z.object({
  name: shortTextSchema,
  designation: shortTextSchema.optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  phone: indianPhoneSchema.optional(),
  isPrimary: z.boolean().default(false),
});

export type CreateCustomerContactDto = z.infer<typeof createCustomerContactSchema>;

export const listCustomersQuerySchema = cursorPaginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  type: customerTypeSchema.optional(),
  distributorId: idSchema.optional(),
  territoryId: idSchema.optional(),
  industryId: idSchema.optional(),
  isActive: z.coerce.boolean().optional(),
});

export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;

export const customerSummarySchema = z.object({
  id: idSchema,
  code: z.string(),
  name: z.string(),
  type: customerTypeSchema,
  distributorId: idSchema.nullable(),
  distributorName: z.string().nullable(),
  territoryId: idSchema.nullable(),
  territoryName: z.string().nullable(),
  industryId: idSchema.nullable(),
  industryName: z.string().nullable(),
  gstin: z.string().nullable(),
  siteName: z.string().nullable(),
  tags: z.array(z.string()),
  isActive: z.boolean(),
  contactCount: z.number().int().nonnegative(),
  orderCount: z.number().int().nonnegative(),
  createdAt: dateTimeSchema,
});

export type CustomerSummary = z.infer<typeof customerSummarySchema>;
