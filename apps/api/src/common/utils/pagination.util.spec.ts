import { encodeCursor } from '@hixaa/contracts';
import { keysetWhere, parseSort, toListResult } from './pagination.util';

describe('keysetWhere', () => {
  it('returns undefined for a first page', () => {
    expect(keysetWhere(undefined)).toBeUndefined();
  });

  it('builds a row-comparison predicate that matches the covering index', () => {
    const createdAt = '2026-08-04T10:00:00.000Z';
    const where = keysetWhere(encodeCursor({ createdAt, id: 'abc' })) as {
      OR: Array<Record<string, unknown>>;
    };

    // (createdAt, id) < (?, ?) — the tie-breaker on id is what prevents rows
    // sharing a timestamp from being skipped or repeated across pages.
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ createdAt: { lt: new Date(createdAt) } });
    expect(where.OR[1]).toEqual({ createdAt: new Date(createdAt), id: { lt: 'abc' } });
  });

  it('falls back to the first page on a malformed cursor instead of erroring', () => {
    // Cursors are opaque, so a client cannot repair one. A 400 would strand a
    // user on a stale bookmark with no way forward.
    for (const bad of ['not-base64', encodeCursor({}), encodeCursor({ createdAt: 'nonsense', id: 'x' })]) {
      expect(keysetWhere(bad)).toBeUndefined();
    }
  });
});

describe('toListResult', () => {
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `id-${index}`,
      createdAt: new Date(2026, 7, 4, 10, 0, count - index),
    }));

  it('trims the over-fetched row and reports hasMore', () => {
    // Fetching limit+1 is how hasMore is known without a second COUNT query.
    const result = toListResult(rows(11), 10);
    expect(result.data).toHaveLength(10);
    expect(result.meta.cursor.hasMore).toBe(true);
    expect(result.meta.cursor.next).not.toBeNull();
  });

  it('reports the end of the collection', () => {
    const result = toListResult(rows(4), 10);
    expect(result.data).toHaveLength(4);
    expect(result.meta.cursor.hasMore).toBe(false);
    expect(result.meta.cursor.next).toBeNull();
  });

  it('handles an empty result without producing a cursor', () => {
    const result = toListResult([], 10);
    expect(result.data).toEqual([]);
    expect(result.meta.cursor.next).toBeNull();
  });

  it('omits totalCount unless the caller asked for it', () => {
    // A COUNT over a large filtered set often costs more than the page itself.
    expect(toListResult(rows(3), 10).meta.totalCount).toBeUndefined();
    expect(toListResult(rows(3), 10, 42).meta.totalCount).toBe(42);
  });

  it('builds the next cursor from the LAST row of the page, not the buffer row', () => {
    const page = rows(11);
    const result = toListResult(page, 10);
    const decoded = JSON.parse(
      Buffer.from(result.meta.cursor.next!, 'base64url').toString('utf8'),
    ) as { id: string };
    expect(decoded.id).toBe('id-9');
  });
});

describe('parseSort', () => {
  const allowed = ['createdAt', 'email', 'lastLoginAt'];

  it('parses direction prefixes', () => {
    expect(parseSort('email', allowed)).toEqual([{ email: 'asc' }, { id: 'desc' }]);
    expect(parseSort('-email', allowed)).toEqual([{ email: 'desc' }, { id: 'desc' }]);
  });

  it('supports multiple fields in order', () => {
    expect(parseSort('-lastLoginAt,email', allowed)).toEqual([
      { lastLoginAt: 'desc' },
      { email: 'asc' },
      { id: 'desc' },
    ]);
  });

  it('silently drops fields outside the allow-list', () => {
    // Sorting on an unindexed column invites a full table scan, and accepting
    // arbitrary field names makes the sort parameter an injection surface.
    expect(parseSort('passwordHash', allowed)).toEqual([
      { createdAt: 'desc' },
      { id: 'desc' },
    ]);
    expect(parseSort('email,passwordHash', allowed)).toEqual([
      { email: 'asc' },
      { id: 'desc' },
    ]);
  });

  it('always appends the id tie-breaker', () => {
    // Without it, pagination over a column with duplicates skips or repeats.
    for (const sort of ['email', '-createdAt', 'email,lastLoginAt']) {
      const parsed = parseSort(sort, allowed);
      expect(parsed[parsed.length - 1]).toEqual({ id: 'desc' });
    }
  });

  it('falls back to the default ordering when no sort is given', () => {
    expect(parseSort(undefined, allowed)).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });
});
