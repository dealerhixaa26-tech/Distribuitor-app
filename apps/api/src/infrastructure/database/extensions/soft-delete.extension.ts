import { Prisma } from '@prisma/client';

/**
 * Soft delete, applied globally.
 *
 * `delete` becomes `update { deletedAt }`, and every read excludes soft-deleted
 * rows unless explicitly asked otherwise. Applying this as a client extension
 * rather than a convention means a developer cannot forget the filter — the
 * default is safe and opting out is explicit.
 *
 * Financial documents (invoices, payments, ledger entries) deliberately have no
 * `deletedAt` column: they are cancelled, never deleted, so they are untouched
 * by this extension by construction rather than by discipline.
 *
 * ── One deliberate gap: `findUnique` ───────────────────────────────────────
 * Prisma's `findUnique` only accepts a unique predicate, so `deletedAt: null`
 * cannot be added to it. It is therefore NOT intercepted and will happily
 * return a soft-deleted row.
 *
 * Rather than silently rewriting it to `findFirst` — which would change the
 * query's uniqueness guarantees behind the caller's back — repositories use
 * `findFirst` for soft-deletable models. Phase 2 adds a repository base class
 * that makes that the only available option.
 */

/**
 * Derived from the generated schema rather than hand-listed, so adding
 * `deletedAt` to a new model in Phase 5 enrols it automatically and a
 * hand-maintained list cannot drift out of date.
 */
const SOFT_DELETABLE: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === 'deletedAt'))
    .map((model) => model.name.charAt(0).toLowerCase() + model.name.slice(1)),
);

export const isSoftDeletable = (model: string): boolean => SOFT_DELETABLE.has(model);

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

      // ── delete → soft delete ──────────────────────────────────────────────
      async delete({ model, args, query }) {
        if (!isSoftDeletable(model)) return query(args);
        const context = Prisma.getExtensionContext(this) as unknown as {
          update: (a: unknown) => Promise<unknown>;
        };
        return context.update({
          where: (args as AnyArgs).where,
          data: { deletedAt: new Date() },
        });
      },

      async deleteMany({ model, args, query }) {
        if (!isSoftDeletable(model)) return query(args);
        const context = Prisma.getExtensionContext(this) as unknown as {
          updateMany: (a: unknown) => Promise<unknown>;
        };
        return context.updateMany({
          where: { ...((args as AnyArgs).where ?? {}), deletedAt: null },
          data: { deletedAt: new Date() },
        });
      },
    },
  },
});
