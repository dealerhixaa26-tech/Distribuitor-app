import base from './base.js';
import globals from 'globals';

export default [
  ...base,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // Server Components and route handlers legitimately log.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
];
