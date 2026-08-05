import nest from '@hixaa/config/eslint/nest';

export default [
  ...nest,
  {
    /*
     * `src/scripts/` holds verification harnesses run by hand from the command
     * line — `verify-worker-jobs.ts`, `verify-backup.ts`. Printing a readable
     * report IS their output, so `no-console` is noise here rather than a
     * signal, and the alternative is a disable comment on every other line.
     *
     * They live under src/ rather than a scripts/ folder because they boot the
     * Nest container, and tsx cannot: esbuild does not implement
     * `emitDecoratorMetadata`, so every constructor injection resolves to
     * undefined. They must be compiled by tsc.
     */
    files: ['src/scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
];
