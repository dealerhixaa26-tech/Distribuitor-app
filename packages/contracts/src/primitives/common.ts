import { z } from 'zod';

/** Primitives shared by every resource contract. */

export const uuidSchema = z.string().uuid('Must be a valid UUID');

export const idSchema = uuidSchema.describe('UUID v7 identifier');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('Must be a valid email address');

/**
 * Human-readable business code, e.g. `DIST-00042`, `SO-2627-00118`.
 * Distinct from the UUID: codes are what people say on the phone.
 */
export const businessCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(40)
  .regex(/^[A-Z0-9][A-Z0-9/-]*$/, 'Only letters, digits, hyphens, and slashes');

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be lowercase words separated by single hyphens');

export const shortTextSchema = z.string().trim().min(1).max(200);
export const mediumTextSchema = z.string().trim().min(1).max(1000);
export const longTextSchema = z.string().trim().max(10_000);

/** ISO 8601 instant. All timestamps are UTC on the wire. */
export const dateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .describe('ISO 8601 timestamp in UTC');

/** Calendar date with no time component — invoice dates, due dates. */
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD form')
  .describe('Calendar date, YYYY-MM-DD');

export const urlSchema = z.string().trim().url().max(2048);

export const tagsSchema = z
  .array(z.string().trim().min(1).max(40))
  .max(25, 'At most 25 tags')
  .default([]);

/** Freeform metadata. Deliberately capped — this is not a schema escape hatch. */
export const metadataSchema = z.record(z.string(), z.unknown()).default({});

/** Non-negative integer, e.g. sort order, retry count. */
export const countSchema = z.number().int().nonnegative();

/** Positive integer. */
export const positiveIntSchema = z.number().int().positive();

/**
 * Idempotency key accompanying money-moving POSTs. Client-generated UUID.
 * See docs/03-api-design.md §5.
 */
export const idempotencyKeySchema = z
  .string()
  .uuid('Idempotency-Key must be a UUID')
  .describe('Client-generated key that makes a retried request safe');

/** Wraps a single resource: `{ data: T }`. */
export const dataEnvelope = <T extends z.ZodTypeAny>(schema: T) => z.object({ data: schema });

/** Standard audit fields present on every business entity response. */
export const auditFieldsSchema = z.object({
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  createdById: idSchema.nullable(),
  updatedById: idSchema.nullable(),
});

export type AuditFields = z.infer<typeof auditFieldsSchema>;
