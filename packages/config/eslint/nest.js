import base from './base.js';

/**
 * NestJS relaxes two base rules by necessity:
 *  - decorator metadata legitimately produces "unused" constructor params
 *  - `new Date()` is allowed inside the Clock provider itself
 */
export default [
  ...base,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',

      /**
       * MUST stay off for NestJS. `emitDecoratorMetadata` writes constructor
       * parameter types into `design:paramtypes` at runtime, and that metadata
       * is how Nest resolves dependencies. A `type` import is erased by the
       * compiler, so this rule's autofix silently turns every injected
       * dependency into `UnknownDependenciesException` at boot.
       *
       * Verified the hard way: enabling it took the API from booting to
       * "Nest can't resolve dependencies of the AppConfigService (?)".
       *
       * Explicit `import type { … }` for genuine types (interfaces, DTO shapes)
       * is still correct and used throughout — it just cannot be enforced
       * mechanically here.
       */
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    files: ['**/clock.service.ts', '**/*.spec.ts', '**/*.e2e-spec.ts', '**/seed/**'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  {
    /**
     * The Clock rule targets BUSINESS logic, where time changes an outcome —
     * token expiry, financial-year rollover, aging buckets, reservation
     * timeouts. Those must be testable against a fixed clock instead of a
     * sleep.
     *
     * Infrastructure adapters are different: stamping `sentAt` on a log row or
     * `deletedAt` on a soft delete records when something physically happened.
     * Injecting a clock there adds ceremony and buys no test value, and a rule
     * that fires on every legitimate use is a rule people learn to suppress.
     *
     * Where an adapter does contain real time MATH (the outbox backoff), that
     * math is extracted into a pure exported function and unit-tested directly.
     */
    files: ['**/infrastructure/**', '**/jobs/**', '**/health/**', '**/main.ts', '**/worker.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
