/**
 * Normalises a Prisma model name to the key both extension registries use.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Prisma client extensions receive `model` as the name declared in the schema —
 * PascalCase, e.g. `"Territory"`. The client's own property is camelCase
 * (`prisma.territory`), and both `SCOPE_REGISTRY` and the soft-delete set were
 * keyed that way.
 *
 * The mismatch meant every registry lookup missed, so BOTH extensions were
 * silent no-ops: scope predicates were never injected, and soft-deletable
 * models were hard-deleted and never filtered. Nothing failed loudly — the
 * queries simply ran unguarded.
 *
 * One helper, used at every boundary, so the two casings can never diverge
 * again.
 */
export function modelKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}
