import { z } from 'zod';
import {
  businessCodeSchema,
  dateTimeSchema,
  idSchema,
  mediumTextSchema,
  shortTextSchema,
  slugSchema,
} from '../primitives/common';
import { cursorPaginationSchema } from '../primitives/pagination';

/**
 * Category contracts.
 *
 * Categories are a tree with the same materialised-path scheme as Territory,
 * and the API deliberately exposes the same shape — `path` and `depth` are
 * returned so a client can render a tree without a second round trip per level.
 */

export const createCategorySchema = z.object({
  code: businessCodeSchema,
  name: shortTextSchema,
  slug: slugSchema.optional(),
  parentId: idSchema.optional(),
  description: mediumTextSchema.optional(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  imageDocumentId: idSchema.optional(),
  isActive: z.boolean().default(true),
});

export type CreateCategoryDto = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = createCategorySchema
  .partial()
  // The parent is changed through `POST /categories/:id/move`, which runs the
  // cycle check and rewrites every descendant's path in one transaction.
  // Allowing it here would let a plain PATCH silently orphan a subtree.
  .omit({ parentId: true, code: true });

export type UpdateCategoryDto = z.infer<typeof updateCategorySchema>;

export const moveCategorySchema = z.object({
  /** Null promotes the category to a root. */
  parentId: idSchema.nullable(),
});

export const listCategoriesQuerySchema = cursorPaginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  parentId: idSchema.optional(),
  isActive: z.coerce.boolean().optional(),
  /** Returns the whole subtree under `parentId` rather than direct children. */
  includeDescendants: z.coerce.boolean().default(false),
});

export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;

export const categorySummarySchema = z.object({
  id: idSchema,
  code: z.string(),
  name: z.string(),
  slug: z.string(),
  parentId: idSchema.nullable(),
  path: z.string(),
  depth: z.number().int(),
  description: z.string().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  productCount: z.number().int().nonnegative(),
  createdAt: dateTimeSchema,
});

export type CategorySummary = z.infer<typeof categorySummarySchema>;

/**
 * The minimum a row needs to be assembled into a tree.
 *
 * Deliberately narrower than `CategorySummary`: the API's own rows carry
 * `createdAt` as a `Date` until the transform interceptor serialises it at the
 * edge, so a builder demanding the full wire shape could not be called from a
 * service without a pointless mapping pass. See HANDOFF §4.7.
 */
export interface CategoryTreeFields {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
}

/** A node with its children inlined, for the tree endpoint. */
export type CategoryNode<T extends CategoryTreeFields = CategorySummary> = T & {
  children: Array<CategoryNode<T>>;
};

/**
 * Assembles a flat, path-ordered list into a tree.
 *
 * Lives in contracts rather than in either app because the API returns the tree
 * on `GET /categories/tree` and the web rebuilds it after client-side
 * filtering. One implementation means the two orderings cannot disagree.
 */
export function buildCategoryTree<T extends CategoryTreeFields>(
  rows: readonly T[],
): Array<CategoryNode<T>> {
  const nodes = new Map<string, CategoryNode<T>>();
  for (const row of rows) nodes.set(row.id, { ...row, children: [] });

  const roots: Array<CategoryNode<T>> = [];
  for (const row of rows) {
    const node = nodes.get(row.id);
    if (!node) continue;

    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    // A node whose parent is absent from this result set — filtered out, or
    // outside the caller's page — is surfaced as a root rather than dropped.
    // Silently discarding it would make the count disagree with the tree.
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortRecursive = (list: Array<CategoryNode<T>>): Array<CategoryNode<T>> => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    for (const node of list) sortRecursive(node.children);
    return list;
  };

  return sortRecursive(roots);
}
