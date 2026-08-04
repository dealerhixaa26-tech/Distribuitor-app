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
      async update({ model, args, query }) {
        return query(applyScope(model, args) as never);
      },
      async updateMany({ model, args, query }) {
        return query(applyScope(model, args) as never);
      },
      async delete({ model, args, query }) {
        return query(applyScope(model, args) as never);
      },
      async deleteMany({ model, args, query }) {
        return query(applyScope(model, args) as never);
      },
    },
  },
});

type ScopableArgs = { where?: Record<string, unknown> } & Record<string, unknown>;

function applyScope<T extends ScopableArgs | undefined>(model: string, args: T): T {
  if (!isScopedModel(model)) return args;

  const context = RequestContextStore.get();

  // No ambient context means no HTTP request: migrations, seeds, and the
  // worker's own bootstrapping. Those run as the system principal.
  if (!context || context.bypassScope) return args;

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

  // AND-composed rather than merged, so a caller-supplied filter on the same
  // column narrows the scope instead of overwriting it.
  return {
    ...(args ?? {}),
    where: existing ? { AND: [existing, predicate] } : predicate,
  } as T;
}
