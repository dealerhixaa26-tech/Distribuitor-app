import type { EffectiveAccess } from '@hixaa/contracts';
import { modelKey } from './model-key';

/**
 * Declares how each model is bounded by the caller's data scope. See ADR-0003.
 *
 * A model registered here has the caller's scope predicate injected into every
 * read by the scope extension. A model NOT registered here is globally
 * readable, which is correct for reference data (permissions, states, units)
 * and wrong for anything owned by a territory or a distributor.
 *
 * As of Phase 3 this is live: `territory` and `warehouse` are registered, so
 * the extension is filtering real rows rather than being machinery waiting for
 * its first entry.
 */

export type ScopePredicate = Record<string, unknown> | null;

export interface ScopeStrategy {
  /**
   * Builds the `where` fragment for this model given the caller's access.
   * Returning `null` means "no restriction" (the caller is global).
   */
  build(access: EffectiveAccess): ScopePredicate;
}

/** Matches nothing. The safe answer when a caller has no scope to speak of. */
const DENY_ALL: ScopePredicate = { id: { in: [] as string[] } };

/**
 * The territory tree itself.
 *
 * A user scoped to a zone must see that zone AND everything under it, so this
 * matches on the materialised path rather than on id equality. Assigning
 * someone the West zone and having them see only the zone node — not its
 * states — would make territory scoping useless.
 *
 * `territoryPaths` is resolved once per request by AccessService; matching on
 * a path prefix is what turns one assignment into a whole subtree.
 */
export const territorySelf = (): ScopeStrategy => ({
  build(access) {
    if (access.scopeType === 'GLOBAL') return null;
    if (access.scopeType !== 'TERRITORY') return DENY_ALL;
    if (access.territoryIds.length === 0) return DENY_ALL;

    // The ids have already been expanded to include descendants, so a plain
    // `in` is both correct and index-friendly here.
    return { id: { in: access.territoryIds } };
  },
});

/** The model owns a `territoryId` column directly. */
export const byTerritory = (column = 'territoryId'): ScopeStrategy => ({
  build(access) {
    if (access.scopeType === 'GLOBAL') return null;
    if (access.scopeType !== 'TERRITORY') return DENY_ALL;
    if (access.territoryIds.length === 0) return DENY_ALL;
    return { [column]: { in: access.territoryIds } };
  },
});

/** The model owns a `distributorId` column directly. */
export const byDistributor = (column = 'distributorId'): ScopeStrategy => ({
  build(access) {
    if (access.scopeType === 'GLOBAL') return null;
    if (access.scopeType === 'DISTRIBUTOR') {
      if (access.distributorIds.length === 0) return DENY_ALL;
      return { [column]: { in: access.distributorIds } };
    }
    return null;
  },
});

/**
 * The model reaches a territory through its parent distributor — e.g. an Order
 * has no territoryId but its Distributor does.
 */
export const viaDistributor = (relation = 'distributor'): ScopeStrategy => ({
  build(access) {
    if (access.scopeType === 'GLOBAL') return null;

    if (access.scopeType === 'DISTRIBUTOR') {
      if (access.distributorIds.length === 0) return DENY_ALL;
      return { distributorId: { in: access.distributorIds } };
    }

    if (access.territoryIds.length === 0) return DENY_ALL;
    return { [relation]: { territoryId: { in: access.territoryIds } } };
  },
});

/**
 * The scope registry. Keys are Prisma model names as they appear in
 * `Prisma.ModelName` (camelCase).
 */
export const SCOPE_REGISTRY: Readonly<Record<string, ScopeStrategy>> = {
  // ── Phase 3 — live ──
  territory: territorySelf(),
  warehouse: byTerritory(),

  // ── Phase 5 ──
  // distributor: byTerritory(),
  // ── Phase 7 ──
  // order:       viaDistributor(),
  // quotation:   viaDistributor(),
  // shipment:    viaDistributor(),
  // customer:    byTerritory(),
  // ── Phase 8 ──
  // invoice:     viaDistributor(),
  // payment:     viaDistributor(),
};

// Prisma hands extensions a PascalCase model name; the registry is keyed
// camelCase. Normalising here is what makes the lookup actually hit — see
// model-key.ts for the bug this prevents.
export const isScopedModel = (model: string): boolean =>
  Object.prototype.hasOwnProperty.call(SCOPE_REGISTRY, modelKey(model));

export const scopeFor = (model: string): ScopeStrategy | undefined =>
  SCOPE_REGISTRY[modelKey(model)];
