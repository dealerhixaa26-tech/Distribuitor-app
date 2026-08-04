import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/index.ts'],
      // Pure logic with catastrophic failure modes — held to a high bar.
      thresholds: { statements: 85, branches: 80, functions: 85, lines: 85 },
    },
  },
});
