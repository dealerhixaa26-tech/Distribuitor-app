/**
 * Materialised-path helpers for the territory tree.
 *
 * A path is `.<ancestorId>.<…>.<selfId>.` — dot-delimited with LEADING and
 * TRAILING dots. Both matter: without them `LIKE '%<id>%'` could match an id
 * that merely contains another as a substring, silently pulling unrelated
 * subtrees into a scope check.
 *
 * Why a materialised path rather than a recursive CTE:
 *   "every distributor in the West zone" becomes one indexed `LIKE '.<id>.%'`
 *   instead of a recursive walk on every request. Territory trees are read
 *   constantly (every scoped query consults one) and written rarely, so the
 *   cost of maintaining the path on write is repaid many times over.
 *
 * These are pure functions so the tree invariants can be tested directly,
 * without a database.
 */

export const PATH_SEPARATOR = '.';

/** Builds a node's path from its parent's path. */
export function buildPath(parentPath: string | null | undefined, selfId: string): string {
  if (!parentPath) return `${PATH_SEPARATOR}${selfId}${PATH_SEPARATOR}`;
  return `${parentPath}${selfId}${PATH_SEPARATOR}`;
}

/** Ancestor ids, root first, excluding the node itself. */
export function ancestorIds(path: string): string[] {
  const parts = path.split(PATH_SEPARATOR).filter(Boolean);
  return parts.slice(0, -1);
}

/** Depth is the number of ancestors: a root is depth 0. */
export function depthOf(path: string): number {
  return Math.max(0, path.split(PATH_SEPARATOR).filter(Boolean).length - 1);
}

/**
 * `LIKE` pattern matching a node AND all of its descendants.
 *
 * Used by the scope extension: a user scoped to the West zone should see the
 * zone and everything under it.
 */
export function subtreePattern(path: string): string {
  return `${path}%`;
}

/** True when `candidatePath` is at or below `ancestorPath`. */
export function isWithinSubtree(candidatePath: string, ancestorPath: string): boolean {
  return candidatePath.startsWith(ancestorPath);
}

/**
 * Rewrites a descendant's path when its subtree is moved.
 *
 * Example: moving `.a.b.` under `.x.` rewrites `.a.b.c.` → `.x.b.c.`.
 */
export function rewritePath(
  descendantPath: string,
  oldAncestorPath: string,
  newAncestorPath: string,
): string {
  if (!descendantPath.startsWith(oldAncestorPath)) return descendantPath;
  return newAncestorPath + descendantPath.slice(oldAncestorPath.length);
}

/**
 * Guards against a move that would make a node its own ancestor.
 *
 * Reparenting a node under one of its own descendants detaches the whole
 * subtree into an unreachable cycle — the tree is no longer a tree, and every
 * recursive read either loops forever or silently loses rows.
 */
export function wouldCreateCycle(nodePath: string, targetPath: string): boolean {
  return targetPath.startsWith(nodePath);
}
