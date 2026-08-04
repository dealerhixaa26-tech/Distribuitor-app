import { Prisma } from '@prisma/client';
import { modelKey } from './model-key';
import { isSoftDeletable } from './extensions/soft-delete.extension';
import { isScopedModel } from './scope-registry';

/**
 * Regression tests for a bug that made BOTH client extensions silent no-ops.
 *
 * Prisma passes extensions a PascalCase model name (`"Territory"`), while both
 * registries were keyed camelCase (`territory`). Every lookup missed, so scope
 * predicates were never injected and soft-deletable models were hard-deleted
 * and never filtered — with nothing failing loudly.
 */
describe('modelKey', () => {
  it('normalises PascalCase to camelCase', () => {
    expect(modelKey('Territory')).toBe('territory');
    expect(modelKey('UserRole')).toBe('userRole');
    expect(modelKey('OutboxEvent')).toBe('outboxEvent');
  });

  it('leaves an already-camelCase name unchanged (idempotent)', () => {
    expect(modelKey('territory')).toBe('territory');
    expect(modelKey(modelKey('Territory'))).toBe('territory');
  });
});

describe('extension registries accept the name Prisma actually passes', () => {
  /**
   * The exact strings the extension receives, taken from the generated schema
   * rather than hand-written — so this test cannot drift from reality.
   */
  const prismaModelNames = Prisma.dmmf.datamodel.models.map((model) => model.name);

  it('exposes PascalCase model names, which is what made the bug possible', () => {
    expect(prismaModelNames).toContain('Territory');
    expect(prismaModelNames).toContain('User');
  });

  it('recognises scoped models by their PascalCase name', () => {
    // The regression: this returned false, so no scope predicate was applied.
    expect(isScopedModel('Territory')).toBe(true);
    expect(isScopedModel('Warehouse')).toBe(true);
    expect(isScopedModel('territory')).toBe(true);
  });

  it('does not scope reference data', () => {
    expect(isScopedModel('Permission')).toBe(false);
    expect(isScopedModel('State')).toBe(false);
  });

  it('recognises soft-deletable models by their PascalCase name', () => {
    // Also returned false, so `delete` was a HARD delete and reads included
    // soft-deleted rows.
    expect(isSoftDeletable('User')).toBe(true);
    expect(isSoftDeletable('Territory')).toBe(true);
    expect(isSoftDeletable('user')).toBe(true);
  });

  it('does not treat append-only or reference tables as soft-deletable', () => {
    expect(isSoftDeletable('AuditLog')).toBe(false);
    expect(isSoftDeletable('Permission')).toBe(false);
    expect(isSoftDeletable('State')).toBe(false);
  });

  it('every soft-deletable model really has a deletedAt column', () => {
    for (const model of Prisma.dmmf.datamodel.models) {
      const hasDeletedAt = model.fields.some((field) => field.name === 'deletedAt');
      expect(isSoftDeletable(model.name)).toBe(hasDeletedAt);
    }
  });
});
