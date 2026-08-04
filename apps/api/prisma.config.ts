import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * Two things are happening here:
 *
 * 1. Replaces the deprecated `package.json#prisma` key, which Prisma 7 removes.
 *
 * 2. Loads the env explicitly. Declaring a Prisma config file disables Prisma's
 *    automatic .env discovery, and in a monorepo that discovery would not find
 *    the root .env anyway — the CLI runs from apps/api. Loading it here keeps a
 *    single .env at the repo root rather than duplicating secrets per app.
 */
loadEnv({ path: path.resolve(__dirname, '../../.env'), quiet: true });

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(__dirname, 'prisma', 'migrations'),
    seed: 'tsx prisma/seed/index.ts',
  },
});
