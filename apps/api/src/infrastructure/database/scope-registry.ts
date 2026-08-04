import type { EffectiveAccess } from '@hixaa/contracts';

/**
 * Declares how each model is bounded by the caller's data scope. See ADR-0003.
 *
 * A model registered here has the caller's scope predicate injected into every
 * read by the scope extension. A model NOT registered here is globally
 * readable, which is correct for reference data (permissions, states, units)
 * and wrong for anything owned by a territory or a distributor.
 *
 * Phase 1 registers nothing because no scoped model exists yet — the business
 * domains arrive in Phases 3+. The machinery, its tests, and this registry are
 * built now so that adding `distributor` in Phase 5 is one entry rather than an
 * audit of every query already written.
 */

export type ScopePredicate = Record<string, unknown> | null;

export interface ScopeStrategy {
  /**
   * Builds the `where` fragment for this model given the caller's access.
   * Returning `null` means "no restriction" (the caller is global).
   */
  build(access: EffectiveAccess): ScopePredicate;
}

/** The model owns a `territoryId` column directly. */
export const byTerritory = (column = 'territoryId'): ScopeStrategy => ({
  build(access) {
    if (access.scopeType === 'GLOBAL') return null;
    if (access.scopeType === 'TERRITORY') return { [column]: { in: access.territoryIds } };
    // A distributor-scoped caller never reads by territory.
    return { [column]: { in: [] } };
  },
});

/** The model owns a `distributorId` column directly. */
export const byDistributor = (column = 'distributorId'): ScopeStrategy => ({
  build(access) {
    if (access.scopeType === 'GLOBAL') return null;
    if (access.scopeType === 'DISTRIBUTOR') return { [column]: { in: access.distributorIds } };
    // A territory-scoped caller sees distributors in their territories; the
    // relation walk is declared by `viaDistributor` below.
    return null;
  },
});

/**
 * The model reaches a territory through its parent distributor, e.g. an Order
 * has no territoryId but its Distributor does.
 */
export const viaDistributor = (relation = 'distributor'): ScopeStrategy => ({
  build(access) {
    if (access.scopeType === 'GLOBAL') return null;
    if (access.scopeType === 'DISTRIBUTOR') {
      return { distributorId: { in: access.distributorIds } };
    }
    return { [relation]: { territoryId: { in: access.territoryIds } } };
  },
});

/**
 * The scope registry. Keys are Prisma model names as they appear in
 * `Prisma.ModelName` (camelCase).
 */
export const SCOPE_REGISTRY: Readonly<Record<string, ScopeStrategy>> = {
  // ── Phase 5 ──
  // distributor: byTerritory(),
  // ── Phase 7 ──
  // order:       viaDistributor(),
  // quotation:   viaDistributor(),
  // shipment:    viaDistributor(),
  // ── Phase 8 ──
  // invoice:     viaDistributor(),
  // payment:     viaDistributor(),
  // ── Phase 7 ──
  // customer:    byTerritory(),
};

export const isScopedModel = (model: string): boolean =>
  Object.prototype.hasOwnProperty.call(SCOPE_REGISTRY, model);

export const scopeFor = (model: string): ScopeStrategy | undefined => SCOPE_REGISTRY[model];
