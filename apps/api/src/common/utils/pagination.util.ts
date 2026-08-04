import { decodeCursor, encodeCursor, type ListResult } from '@hixaa/contracts';

/**
 * Keyset (cursor) pagination helpers.
 *
 * `OFFSET 50000` makes Postgres read and discard 50 000 rows before returning
 * anything. Keyset reads exactly the page. At the scale this system targets —
 * 1M+ products, millions of order lines — that is the difference between a
 * fast list and an unusable one. See docs/03-api-design.md §2.
 */

export interface KeysetCursor extends Record<string, unknown> {
  /** ISO timestamp of the last row on the previous page. */
  createdAt: string;
  /** Tie-breaker: `createdAt` alone is not unique under concurrent inserts. */
  id: string;
}

/**
 * Builds the `where` fragment that resumes after a cursor.
 *
 * Expressed as `(createdAt, id) < (?, ?)` in row-comparison form, which is
 * exactly what the `(created_at DESC, id DESC)` index supports.
 */
export function keysetWhere(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;

  const decoded = decodeCursor<KeysetCursor>(cursor);
  // A malformed cursor returns the first page rather than an error: cursors
  // are opaque, so a client cannot reasonably repair one, and a 400 here would
  // strand a user on a stale bookmark.
  if (!decoded?.createdAt || !decoded.id) return undefined;

  const createdAt = new Date(decoded.createdAt);
  if (Number.isNaN(createdAt.getTime())) return undefined;

  return {
    OR: [
      { createdAt: { lt: createdAt } },
      { createdAt, id: { lt: decoded.id } },
    ],
  };
}

/**
 * Trims an over-fetched page and builds the response envelope.
 *
 * Fetching `limit + 1` rows is how `hasMore` is determined without a second
 * `COUNT` query.
 */
export function toListResult<T extends { id: string; createdAt: Date }>(
  rows: T[],
  limit: number,
  totalCount?: number,
): ListResult<T> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    data: page,
    meta: {
      cursor: {
        next:
          hasMore && last
            ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
        hasMore,
      },
      ...(totalCount !== undefined ? { totalCount } : {}),
    },
  };
}

export type OrderBy = Record<string, 'asc' | 'desc'>;

/** Standard ordering for keyset pagination. Must match the covering index. */
export const KEYSET_ORDER: OrderBy[] = [{ createdAt: 'desc' }, { id: 'desc' }];

/**
 * Translates a `sort=-createdAt,name` string into Prisma `orderBy`, restricted
 * to an allow-list.
 *
 * The allow-list is not optional: sorting on an unindexed column invites a full
 * table scan, and accepting arbitrary field names is how sort parameters become
 * an injection surface.
 */
export function parseSort(
  sort: string | undefined,
  allowed: readonly string[],
  fallback: OrderBy[] = KEYSET_ORDER,
): OrderBy[] {
  if (!sort) return fallback;

  const parsed = sort
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const desc = token.startsWith('-');
      const field = desc ? token.slice(1) : token;
      return allowed.includes(field)
        ? ({ [field]: desc ? 'desc' : 'asc' } satisfies OrderBy)
        : null;
    })
    .filter((entry): entry is OrderBy => entry !== null);

  // Always append the id tie-breaker, or pagination can skip or repeat rows
  // when the sort column has duplicates.
  return parsed.length ? [...parsed, { id: 'desc' }] : fallback;
}
