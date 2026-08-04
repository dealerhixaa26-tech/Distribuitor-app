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
 * The model reaches a territory through the WAREHOUSE that holds it.
 *
 * Stock is not owned by a territory; a warehouse is, and stock lives in a
 * warehouse. Nesting the predicate keeps one definition of "which warehouses
 * can this caller see" rather than copying the rule per inventory table.
 */
export const viaWarehouse = (relation = 'warehouse'): ScopeStrategy => ({
  build(access) {
    if (access.scopeType === 'GLOBAL') return null;
    if (access.scopeType !== 'TERRITORY') return DENY_ALL;
    if (access.territoryIds.length === 0) return DENY_ALL;
    return { [relation]: { territoryId: { in: access.territoryIds } } };
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
 * Reaches a territory through EITHER a distributor or a customer.
 *
 * A PRIMARY order names a distributor; a SECONDARY order names a customer and
 * may have no distributor at all. Using `viaDistributor()` alone would make
 * every sell-out invisible to a territory-scoped user — the rows would simply
 * not match, which is the quiet kind of failure that reads as "no data yet".
 */
export const viaDistributorOrCustomer = (): ScopeStrategy => ({
  build(access) {
    if (access.scopeType === 'GLOBAL') return null;

    if (access.scopeType === 'DISTRIBUTOR') {
      if (access.distributorIds.length === 0) return DENY_ALL;
      return { distributorId: { in: access.distributorIds } };
    }

    if (access.territoryIds.length === 0) return DENY_ALL;
    return {
      OR: [
        { distributor: { territoryId: { in: access.territoryIds } } },
        { customer: { territoryId: { in: access.territoryIds } } },
      ],
    };
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

  // ── Phase 5 — live ──
  // A distributor belongs to one territory, so the boundary is a direct column
  // match against the caller's already-expanded subtree.
  distributor: byTerritory(),

  // ── Phase 4 — live ──
  // The authorized catalog reaches a territory only through its distributor, so
  // it is scoped via the relation rather than by a column it does not have.
  //
  // This is the ONLY catalog model registered here, and deliberately so:
  // products, categories, price lists, discount rules, and tax rates are
  // company-wide reference data. Scoping them would make the catalog invisible
  // to every non-global user; NOT scoping this one would leak one partner's
  // commercial terms to a manager in another territory.
  distributorProduct: viaDistributor(),

  // ── Phase 6 — live ──
  // Stock has no territory of its own; it reaches one through the warehouse
  // that holds it. `warehouse` is itself scoped by territory (Phase 3), so
  // nesting the predicate here bounds every stock read to the caller's subtree.
  //
  // The LEDGER is scoped too, not just the balance: it records who shipped what
  // to whom, and reading another territory's movement history would leak the
  // same commercial information the balance does.
  stockBalance: viaWarehouse(),
  stockLedgerEntry: viaWarehouse(),
  stockReservation: viaWarehouse(),
  inventorySetting: viaWarehouse(),
  stockCount: viaWarehouse(),
  // A serial's warehouse is NULL once dispatched, so a warehouse predicate
  // would hide exactly the rows the trace lookup exists to find. Scoped by the
  // receiving distributor instead — which is the question being asked anyway:
  // "which of MY partners has this unit?"
  serialNumber: byDistributor('currentDistributorId'),

  // ── Phase 7 — live ──
  // An order reaches a territory through its distributor. A SECONDARY order has
  // no distributor of its own, so it falls back to the customer's territory —
  // handled by `viaDistributorOrCustomer` below.
  order:     viaDistributorOrCustomer(),
  quotation: viaDistributorOrCustomer(),
  // A shipment has neither; it reaches a territory through the WAREHOUSE it
  // ships from, which is already territory-scoped.
  shipment:  viaWarehouse(),
  customer:  byTerritory(),
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
