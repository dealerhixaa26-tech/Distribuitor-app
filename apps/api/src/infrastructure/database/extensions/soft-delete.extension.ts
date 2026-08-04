import { Prisma } from '@prisma/client';
import { modelKey } from '../model-key';

/**
 * Soft delete, applied globally.
 *
 * Every read on a soft-deletable model excludes `deletedAt IS NOT NULL` rows,
 * and hard `delete` is BLOCKED outright on those models — callers must use the
 * `softDelete` / `softDeleteMany` methods this extension adds.
 *
 * ── Why blocking rather than silently rewriting ────────────────────────────
 * The first implementation intercepted `delete` and tried to issue an `update`
 * from inside the query hook via `Prisma.getExtensionContext(this)`. That does
 * not work: inside a `query` extension the context is not a model delegate, so
 * every delete failed at runtime with `context.update is not a function`.
 *
 * Rewriting an operation into a different one is not something a `query` hook
 * can do. So the contract is explicit instead: `delete` throws a message that
 * names the method to use, and `softDelete` does the work. A developer cannot
 * accidentally hard-delete a soft-deletable row, and cannot silently get a
 * no-op either — the failure is loud and self-explaining.
 *
 * Financial documents (invoices, payments, ledger entries) deliberately have no
 * `deletedAt` column: they are cancelled, never deleted, so they are untouched
 * by this extension by construction rather than by discipline.
 *
 * ── One deliberate gap: `findUnique` ───────────────────────────────────────
 * Prisma's `findUnique` only accepts a unique predicate, so `deletedAt: null`
 * cannot be added to it. Rather than silently rewriting it to `findFirst` —
 * which would change the query's uniqueness guarantees behind the caller's
 * back — it is left uninterceptable and documented. Repositories use
 * `findFirst` for soft-deletable models.
 */

/**
 * Derived from the generated schema rather than hand-listed, so adding
 * `deletedAt` to a new model enrols it automatically and a hand-maintained list
 * cannot drift out of date.
 */
const SOFT_DELETABLE: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === 'deletedAt'))
    .map((model) => modelKey(model.name)),
);

// Prisma passes extensions a PascalCase model name while dmmf-derived keys are
// camelCase. Normalising both sides through one helper is what makes this
// lookup hit — see model-key.ts.
export const isSoftDeletable = (model: string): boolean => SOFT_DELETABLE.has(modelKey(model));

/** Marker a caller sets to include soft-deleted rows. */
export const WITH_DELETED = Symbol.for('hixaa.withDeleted');

type AnyArgs = Record<string, unknown> & { where?: Record<string, unknown> };

const wantsDeleted = (args: AnyArgs | undefined): boolean =>
  Boolean(args?.where && (args.where as Record<PropertyKey, unknown>)[WITH_DELETED]);

const stripMarker = (where: Record<string, unknown>): Record<string, unknown> => {
  const clone: Record<string, unknown> = { ...where };
  delete (clone as Record<PropertyKey, unknown>)[WITH_DELETED];
  return clone;
};

/** Adds `deletedAt: null` unless the caller opted out. */
const excludeDeleted = (args: AnyArgs = {}): AnyArgs => {
  if (wantsDeleted(args)) return { ...args, where: stripMarker(args.where ?? {}) };
  return { ...args, where: { ...(args.where ?? {}), deletedAt: null } };
};

export const softDeleteExtension = Prisma.defineExtension({
  name: 'softDelete',

  model: {
    $allModels: {
      /**
       * Marks a row deleted. The soft-delete equivalent of `delete`.
       *
       * Implemented as a model method because a `query` hook cannot turn one
       * operation into another.
       */
      async softDelete<T>(this: T, where: unknown): Promise<unknown> {
        const context = Prisma.getExtensionContext(this) as unknown as {
          $name?: string;
          update: (args: unknown) => Promise<unknown>;
        };

        if (context.$name && !isSoftDeletable(context.$name)) {
          throw new Error(
            `${context.$name} has no deletedAt column — use delete() for a hard delete.`,
          );
        }

        return context.update({ where, data: { deletedAt: new Date() } });
      },

      async softDeleteMany<T>(this: T, where: unknown): Promise<unknown> {
        const context = Prisma.getExtensionContext(this) as unknown as {
          $name?: string;
          updateMany: (args: unknown) => Promise<unknown>;
        };

        if (context.$name && !isSoftDeletable(context.$name)) {
          throw new Error(
            `${context.$name} has no deletedAt column — use deleteMany() for a hard delete.`,
          );
        }

        return context.updateMany({
          where: { ...(where as Record<string, unknown>), deletedAt: null },
          data: { deletedAt: new Date() },
        });
      },

      /** Restores a soft-deleted row. */
      async restore<T>(this: T, where: unknown): Promise<unknown> {
        const context = Prisma.getExtensionContext(this) as unknown as {
          update: (args: unknown) => Promise<unknown>;
        };
        return context.update({ where, data: { deletedAt: null } });
      },
    },
  },

  query: {
    $allModels: {
      async findFirst({ model, args, query }) {
        if (!isSoftDeletable(model)) return query(args);
        return query(excludeDeleted(args as AnyArgs));
      },

      async findFirstOrThrow({ model, args, query }) {
        if (!isSoftDeletable(model)) return query(args);
        return query(excludeDeleted(args as AnyArgs));
      },

      async findMany({ model, args, query }) {
        if (!isSoftDeletable(model)) return query(args);
        return query(excludeDeleted(args as AnyArgs));
      },

      async count({ model, args, query }) {
        if (!isSoftDeletable(model)) return query(args);
        return query(excludeDeleted(args as AnyArgs));
      },

      async aggregate({ model, args, query }) {
        if (!isSoftDeletable(model)) return query(args);
        return query(excludeDeleted(args as AnyArgs));
      },

      async update({ model, args, query }) {
        if (!isSoftDeletable(model)) return query(args);
        return query(excludeDeleted(args as AnyArgs) as never);
      },

      async updateMany({ model, args, query }) {
        if (!isSoftDeletable(model)) return query(args);
        return query(excludeDeleted(args as AnyArgs) as never);
      },

      // ── Hard delete is blocked on soft-deletable models ───────────────────
      async delete({ model, args, query }) {
        if (!isSoftDeletable(model)) return query(args);
        throw new Error(
          `${model} is soft-deletable — hard delete would destroy history that other ` +
            `records still reference. Use prisma.${modelKey(model)}.softDelete(where) instead.`,
        );
      },

      async deleteMany({ model, args, query }) {
        if (!isSoftDeletable(model)) return query(args);
        throw new Error(
          `${model} is soft-deletable — use prisma.${modelKey(model)}.softDeleteMany(where).`,
        );
      },
    },
  },
});
