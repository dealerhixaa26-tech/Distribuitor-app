import { z } from 'zod';

/**
 * Pagination contracts. See docs/03-api-design.md §2.
 *
 * Cursor (keyset) pagination is the default because `OFFSET 50000` makes
 * Postgres read and discard 50 000 rows on every page. At the stated scale
 * (1M+ products, millions of order lines) that is the difference between a
 * fast list and an unusable one.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
/** Beyond this, offset pagination is rejected rather than allowed to scan. */
export const MAX_OFFSET_PAGE = 500;

const limitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE, `Page size cannot exceed ${MAX_PAGE_SIZE}`)
  .default(DEFAULT_PAGE_SIZE);

export const cursorPaginationSchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: limitSchema,
  /**
   * `COUNT(*)` over a large filtered set is frequently more expensive than the
   * page itself, so callers opt in to paying for it.
   */
  includeTotal: z.coerce.boolean().default(false),
});

export type CursorPagination = z.infer<typeof cursorPaginationSchema>;

export const offsetPaginationSchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_OFFSET_PAGE, `Use cursor pagination beyond page ${MAX_OFFSET_PAGE}`)
    .default(1),
  pageSize: limitSchema,
});

export type OffsetPagination = z.infer<typeof offsetPaginationSchema>;

/** `sort=-orderDate,orderNumber` → [{field:'orderDate',dir:'desc'}, …] */
export const sortSchema = z
  .string()
  .max(200)
  .transform((value) =>
    value
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean)
      .map((token) => ({
        field: token.startsWith('-') ? token.slice(1) : token,
        direction: token.startsWith('-') ? ('desc' as const) : ('asc' as const),
      })),
  );

export type SortInstruction = { field: string; direction: 'asc' | 'desc' };

export const searchQuerySchema = z.string().trim().min(1).max(200).optional();

export const cursorMetaSchema = z.object({
  next: z.string().nullable(),
  hasMore: z.boolean(),
});

export const listMetaSchema = z.object({
  cursor: cursorMetaSchema,
  totalCount: z.number().int().nonnegative().optional(),
});

export type ListMeta = z.infer<typeof listMetaSchema>;

/** Wraps a collection: `{ data: T[], meta: {...} }`. */
export const listEnvelope = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), meta: listMetaSchema });

export interface ListResult<T> {
  data: T[];
  meta: ListMeta;
}

/**
 * Opaque cursors. Base64url of `{createdAt, id}` — opaque so clients cannot
 * construct one by hand and depend on its shape, which would freeze our sort
 * implementation forever.
 */
export const encodeCursor = (payload: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

export const decodeCursor = <T = Record<string, unknown>>(cursor: string): T | null => {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
};

/** Filter comparison operators accepted in query strings: `grandTotal[gte]=1000`. */
export const FILTER_OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'like'] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];
