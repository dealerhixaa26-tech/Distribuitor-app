import { Prisma } from '@prisma/client';
import { RequestContextStore } from '../../../common/context/request-context';
import { isScopedModel, scopeFor } from '../scope-registry';

/**
 * Injects the caller's data-scope predicate into every read of a scoped model.
 * This is the load-bearing control described in ADR-0003.
 *
 * Why an extension rather than a helper each repository calls:
 *
 *   A helper must be remembered. Across ~200 query sites and several years,
 *   one will be forgotten, and the failure mode is a distributor seeing another
 *   distributor's pricing. Here the default is filtered; a developer writing
 *   `prisma.db.order.findMany({})` in a brand-new endpoint gets only in-scope
 *   rows without knowing this file exists.
 *
 * Escaping is deliberately explicit and greppable — `RequestContextStore
 * .withoutScope(...)` — so every bypass is a reviewable decision.
 */
export const scopeExtension = Prisma.defineExtension({
  name: 'scope',
  query: {
    $allModels: {
      async findFirst({ model, args, query }) {
        return query(applyScope(model, args));
      },
      async findFirstOrThrow({ model, args, query }) {
        return query(applyScope(model, args));
      },
      async findMany({ model, args, query }) {
        return query(applyScope(model, args));
      },
      async count({ model, args, query }) {
        return query(applyScope(model, args));
      },
      async aggregate({ model, args, query }) {
        return query(applyScope(model, args));
      },
      async groupBy({ model, args, query }) {
        return query(applyScope(model, args) as never);
      },

      // Writes are scoped too: without this, an out-of-scope caller who knows
      // an id could mutate a record they are not permitted to read.
      //
      // `update` and `delete` take a WhereUniqueInput, which MUST carry a
      // top-level unique field — so they compose differently from the bulk
      // operations. See `applyScope`.
      async update({ model, args, query }) {
        return query(applyScope(model, args, 'unique') as never);
      },
      async updateMany({ model, args, query }) {
        return query(applyScope(model, args) as never);
      },
      async delete({ model, args, query }) {
        return query(applyScope(model, args, 'unique') as never);
      },
      async deleteMany({ model, args, query }) {
        return query(applyScope(model, args) as never);
      },
    },
  },
});

type ScopableArgs = { where?: Record<string, unknown> } & Record<string, unknown>;

/**
 * How the predicate is composed into `where`.
 *
 *   `filter` — the default. `{ AND: [caller, predicate] }`, valid for any
 *     WhereInput: finds, counts, updateMany, deleteMany.
 *
 *   `unique` — for `update` and `delete`, whose `where` is a WhereUniqueInput
 *     and must expose at least one UNIQUE field at the TOP level. Burying the
 *     caller's `{ id }` inside an `AND` array satisfies no unique constraint,
 *     and Prisma rejects the call outright:
 *
 *       Argument `where` of type StockBalanceWhereUniqueInput needs at least
 *       one of `id` arguments.
 *
 *     So the unique field is kept where it is and the predicate is appended to
 *     `where.AND` instead. Prisma permits non-unique filters alongside a unique
 *     one, and evaluates both — which is exactly the semantics wanted: find by
 *     id, then refuse unless it is also in scope.
 *
 * This distinction was found by an actual out-of-scope write attempt, not by
 * reading the code. Every GLOBAL caller short-circuits before reaching here
 * (`predicate` is null), so the fault was invisible to every test that used an
 * admin token — see docs/20 §5.
 */
type Composition = 'filter' | 'unique';

/** Exported for direct testing — `Prisma.defineExtension` wraps its argument,
 *  so the hooks themselves are not reachable from a spec. */
export function applyScope<T extends ScopableArgs | undefined>(
  model: string,
  args: T,
  composition: Composition = 'filter',
): T {
  if (!isScopedModel(model)) return args;

  const context = RequestContextStore.get();

  // No ambient context means no HTTP request: migrations, seeds, and the
  // worker's own bootstrapping. Those run as the system principal.
  if (!context || context.bypassScope) return args;

  /*
   * A SYSTEM principal is a background job — a cron sweep, an outbox consumer,
   * a backup. It has no user and no territory, and the whole dataset is exactly
   * its legitimate remit: reconciling every balance against the ledger is
   * meaningless over a subset.
   *
   * This branch exists because the `!access` case below was written to fail
   * closed on an UNAUTHENTICATED REQUEST, and `asSystem()` produces a context
   * of the same shape — actorType SYSTEM, no access. Conflating the two meant
   * every background job read `id IN ()`: the nightly reconciliation checked
   * zero balances and reported `clean` (ADR-0002's drift alarm, structurally
   * unable to fire), reservation expiry released nothing, and low-stock never
   * alerted. All three succeeded loudly while doing nothing. Found in Phase 10
   * by running the jobs twice, once with scope bypassed, and comparing.
   *
   * Note the asymmetry that makes this safe: `actorType` is set to SYSTEM in
   * exactly one place — `RequestContextStore.asSystem()` — and the HTTP
   * middleware always sets USER. No request path can reach this line. See
   * ADR-0021.
   */
  if (context.actorType === 'SYSTEM') return args;

  const access = context.access;
  // An authenticated caller always has resolved access. Its absence means the
  // request is unauthenticated, and an unauthenticated read of a scoped model
  // must return nothing rather than everything.
  if (!access) {
    return {
      ...(args ?? {}),
      where: { ...((args ?? {}).where ?? {}), id: { in: [] as string[] } },
    } as unknown as T;
  }

  const predicate = scopeFor(model)?.build(access);
  if (!predicate) return args;

  const existing = (args ?? {}).where;

  if (composition === 'unique') {
    // Keep the unique field(s) where Prisma expects them and append the scope
    // predicate to `AND`, preserving any AND the caller already supplied.
    const callerAnd = existing?.AND;
    const merged = Array.isArray(callerAnd)
      ? [...callerAnd, predicate]
      : callerAnd
        ? [callerAnd, predicate]
        : [predicate];

    return {
      ...(args ?? {}),
      where: { ...(existing ?? {}), AND: merged },
    } as unknown as T;
  }

  // AND-composed rather than merged, so a caller-supplied filter on the same
  // column narrows the scope instead of overwriting it.
  return {
    ...(args ?? {}),
    where: existing ? { AND: [existing, predicate] } : predicate,
  } as T;
}
