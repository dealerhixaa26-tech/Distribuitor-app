import { RequestContextStore } from '../../../common/context/request-context';
import { applyScope } from './scope.extension';
import type { EffectiveAccess } from '@hixaa/contracts';

/**
 * Scope composition.
 *
 * The bug this file exists to prevent, found in Phase 6 by an actual
 * out-of-scope write attempt rather than by review:
 *
 *   `update` and `delete` take a WhereUniqueInput, which must expose at least
 *   one UNIQUE field at the TOP level. The extension was wrapping the caller's
 *   `{ id }` inside `{ AND: [...] }`, leaving no top-level unique field, and
 *   Prisma rejected every scoped update with a 500.
 *
 * It was invisible for two phases because a GLOBAL caller short-circuits before
 * the predicate is built — so every test using an admin token passed.
 */

const TERRITORY_ACCESS: EffectiveAccess = {
  userId: 'user-1',
  permissions: [],
  scopeType: 'TERRITORY',
  territoryIds: ['territory-a', 'territory-b'],
  distributorIds: [],
};

const GLOBAL_ACCESS: EffectiveAccess = {
  userId: 'admin-1',
  permissions: [],
  scopeType: 'GLOBAL',
  territoryIds: [],
  distributorIds: [],
};

/** Runs the composition and returns the `where` it produced. */
function whereFor(
  access: EffectiveAccess | null,
  model: string,
  args: Record<string, unknown>,
  composition?: 'filter' | 'unique',
): Record<string, unknown> {
  const context = { requestId: 'test', bypassScope: false, ...(access ? { access } : {}) };
  const result = RequestContextStore.run(context as never, () =>
    applyScope(model, args, composition),
  );
  return (result?.where ?? {}) as Record<string, unknown>;
}

describe('scope extension — update/delete compose against a UNIQUE where', () => {
  it('keeps the unique id at the TOP level, not buried in AND', () => {
    const where = whereFor(TERRITORY_ACCESS, 'Warehouse', { where: { id: 'wh-1' } }, 'unique');

    // The whole point: Prisma requires this, and its absence is a 500.
    expect(where.id).toBe('wh-1');
    expect(Array.isArray(where.AND)).toBe(true);
    expect((where.AND as unknown[]).length).toBe(1);
  });

  it('still applies the scope predicate', () => {
    const where = whereFor(TERRITORY_ACCESS, 'Warehouse', { where: { id: 'wh-1' } }, 'unique');

    // Warehouse is scoped byTerritory, so the predicate names territoryId.
    expect(JSON.stringify(where.AND)).toContain('territoryId');
    expect(JSON.stringify(where.AND)).toContain('territory-a');
  });

  it('preserves an AND the caller already supplied rather than replacing it', () => {
    const where = whereFor(
      TERRITORY_ACCESS,
      'Warehouse',
      { where: { id: 'wh-1', AND: [{ isActive: true }] } },
      'unique',
    );

    expect(where.id).toBe('wh-1');
    expect(where.AND).toHaveLength(2);
    expect(JSON.stringify(where.AND)).toContain('isActive');
  });

  it('normalises a non-array AND from the caller', () => {
    const where = whereFor(
      TERRITORY_ACCESS,
      'Warehouse',
      { where: { id: 'wh-1', AND: { isActive: true } } },
      'unique',
    );

    expect(Array.isArray(where.AND)).toBe(true);
    expect(where.AND).toHaveLength(2);
  });

  it('scopes the Phase 6 inventory models the same way', () => {
    for (const model of ['StockBalance', 'StockLedgerEntry', 'StockReservation']) {
      const where = whereFor(TERRITORY_ACCESS, model, { where: { id: 'x' } }, 'unique');
      expect(where.id).toBe('x');
      expect(JSON.stringify(where.AND)).toContain('warehouse');
    }
  });
});

describe('scope extension — bulk operations keep AND-wrapping', () => {
  it('wraps the caller filter and the predicate together', () => {
    const where = whereFor(TERRITORY_ACCESS, 'Warehouse', { where: { isActive: true } });

    // Bulk ops take a plain WhereInput, so top-level AND-wrapping is correct
    // and keeps a caller filter from overwriting the scope.
    expect(Array.isArray(where.AND)).toBe(true);
    expect(where.AND).toHaveLength(2);
  });

  it('uses the predicate alone when the caller supplied no filter', () => {
    const where = whereFor(TERRITORY_ACCESS, 'Warehouse', {});
    expect(JSON.stringify(where)).toContain('territoryId');
  });
});

describe('scope extension — who is exempt', () => {
  it('leaves a GLOBAL caller untouched', () => {
    const where = whereFor(GLOBAL_ACCESS, 'Warehouse', { where: { id: 'wh-1' } }, 'unique');

    // This is precisely why the bug survived two phases: an admin token never
    // reaches the composition code at all.
    expect(where).toEqual({ id: 'wh-1' });
  });

  it('leaves an UNSCOPED model untouched', () => {
    // Products are company-wide reference data — deliberately not scoped.
    const where = whereFor(TERRITORY_ACCESS, 'Product', { where: { id: 'p-1' } }, 'unique');
    expect(where).toEqual({ id: 'p-1' });
  });

  it('denies an unauthenticated caller rather than exposing everything', () => {
    const where = whereFor(null, 'Warehouse', {});
    expect(JSON.stringify(where)).toContain('"in":[]');
  });

  /*
   * ADR-0021. A SYSTEM principal and an unauthenticated request produced the
   * SAME context shape — actorType aside, both have no `access` — so every
   * background job was scoped to the empty set. The jobs did not fail; they
   * succeeded over zero rows, which is why three phases went by without anyone
   * noticing that the nightly drift alarm could not fire.
   *
   * These two tests are a matched pair and must be read together: the first
   * asserts the fix, the second asserts what the fix must NOT do.
   */
  it('leaves a SYSTEM principal unfiltered — a background job owns the dataset', () => {
    const result = RequestContextStore.asSystem('nightly-reconciliation', 'req-1', () =>
      applyScope('Warehouse', { where: { isActive: true } } as Record<string, unknown>),
    );

    // Unfiltered: exactly the caller's own filter, no scope predicate appended.
    expect(result?.where).toEqual({ isActive: true });
    expect(JSON.stringify(result?.where)).not.toContain('"in":[]');
  });

  it('STILL denies an unauthenticated USER context — the control that must not move', () => {
    // The middleware sets actorType USER on every request, authenticated or
    // not. Only `asSystem()` sets SYSTEM, so widening the SYSTEM branch must
    // leave this path exactly as it was.
    const result = RequestContextStore.run({ requestId: 'test', actorType: 'USER' } as never, () =>
      applyScope('Warehouse', {} as Record<string, unknown>),
    );

    expect(JSON.stringify(result?.where)).toContain('"in":[]');
  });

  it('denies a TERRITORY caller holding no territories', () => {
    const where = whereFor(
      { ...TERRITORY_ACCESS, territoryIds: [] },
      'Warehouse',
      { where: { id: 'wh-1' } },
      'unique',
    );
    expect(JSON.stringify(where.AND)).toContain('"in":[]');
  });
});
