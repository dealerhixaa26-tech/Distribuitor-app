import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Shared ESLint flat config for every workspace package.
 *
 * The rules below are the ones that catch real defects in this codebase; stylistic
 * concerns are delegated entirely to Prettier so the two never fight.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', '.next/**', 'coverage/**', 'node_modules/**', '**/*.generated.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Unused code is dead weight; the underscore prefix is the explicit opt-out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // `any` defeats the point of the shared contracts package.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // Money must never be compared or coerced loosely — see ADR-0004.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Inject a Clock instead of `new Date()` so time-dependent logic stays testable.',
        },
      ],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  prettier,
);
