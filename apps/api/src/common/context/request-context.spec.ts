import type { EffectiveAccess } from '@hixaa/contracts';
import { RequestContextStore } from './request-context';

const TERRITORY_ACCESS: EffectiveAccess = {
  userId: 'user-1',
  permissions: [],
  scopeType: 'TERRITORY',
  territoryIds: ['t-1'],
  distributorIds: [],
};

/**
 * `asUser` must keep the context alive until the work FINISHES, not until the
 * callback returns.
 *
 * ── The bug this exists to prevent ─────────────────────────────────────────
 *
 * Prisma operations are LAZY. `prisma.x.count()` builds a `PrismaPromise` that
 * does not execute until awaited. A wrapper written as
 *
 *     return storage.run(ctx, fn);
 *
 * exits the context the moment `fn` hands back an unresolved promise, so the
 * scope extension's `query` hook — where `applyScope` runs — fires OUTSIDE it.
 * `applyScope` then finds no ambient context, takes its no-context branch, and
 * returns the query UNFILTERED.
 *
 * Measured against the real database before the fix, with west.manager
 * (TERRITORY-scoped) and two distributors in different zones:
 *
 *     asUser(p, () => prisma.distributor.count())        → 2   UNSCOPED
 *     asUser(p, async () => prisma.distributor.count())  → 1   scoped
 *
 * The same query, the same user, a different callback shape. For a scheduled
 * report that is one manager receiving every territory's figures by email.
 *
 * The deferred thenable below stands in for a PrismaPromise: it captures the
 * context at the moment it is RESOLVED rather than created, which is exactly
 * where the real hook runs.
 */
describe('RequestContextStore.asUser — context survives lazy work', () => {
  /** Resolves on a later tick, reporting the context visible at that moment. */
  function deferred(): { promise: Promise<ReturnType<typeof RequestContextStore.get>> } {
    return {
      promise: new Promise((resolve) => {
        setTimeout(() => resolve(RequestContextStore.get()), 0);
      }),
    };
  }

  const params = {
    userId: 'user-1',
    access: TERRITORY_ACCESS,
    label: 'test',
    requestId: 'req-1',
  };

  it('keeps the context for work that settles on a later tick', async () => {
    const seen = await RequestContextStore.asUser(params, () => deferred().promise);

    expect(seen).toBeDefined();
    expect(seen?.actorType).toBe('USER');
    expect(seen?.access?.scopeType).toBe('TERRITORY');
  });

  it('behaves identically whether the callback is async or not', async () => {
    // The whole point of awaiting inside: a caller cannot get this wrong by
    // writing the terser arrow.
    const viaPlain = await RequestContextStore.asUser(params, () => deferred().promise);
    const viaAsync = await RequestContextStore.asUser(params, async () => deferred().promise);

    expect(viaPlain?.actorType).toBe('USER');
    expect(viaAsync?.actorType).toBe('USER');
    expect(viaPlain?.access?.scopeType).toBe(viaAsync?.access?.scopeType);
  });

  it('carries the user id and access it was given', async () => {
    const seen = await RequestContextStore.asUser(params, async () =>
      RequestContextStore.get(),
    );

    expect(seen?.userId).toBe('user-1');
    expect(seen?.access?.territoryIds).toEqual(['t-1']);
    // NOT system: a scheduled report must read through the scope predicate, and
    // since ADR-0021 a SYSTEM principal reads unscoped.
    expect(seen?.actorType).not.toBe('SYSTEM');
    expect(seen?.bypassScope).toBeUndefined();
  });

  it('restores the previous context afterwards', async () => {
    await RequestContextStore.asUser(params, async () => undefined);
    expect(RequestContextStore.get()).toBeUndefined();
  });
});
