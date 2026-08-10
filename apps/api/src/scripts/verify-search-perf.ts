/**
 * Phase 11.2 — proves the fuzzy product search through the APPLICATION path.
 *
 * The psql comparison showed the operator form is index-eligible and returns
 * the same rows. This checks the thing psql cannot: that `ProductsService`
 * itself still finds a typo'd product, now that the WHERE clause uses `<%`
 * inside a transaction with `SET LOCAL word_similarity_threshold`.
 *
 * Point DATABASE_URL at the load database to measure it at 1M products:
 *   DATABASE_URL="postgresql://…/hixaa_dms_load?schema=public" \
 *     node apps/api/dist/scripts/verify-search-perf.js
 *
 * Run: pnpm --filter @hixaa/api build && node apps/api/dist/scripts/verify-search-perf.js
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { RequestContextStore } from '../common/context/request-context';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { ProductsService } from '../modules/catalog/products.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });

  let failures = 0;
  const check = (label: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? '  ✓' : '  ✗'} ${label}\n      ${detail}`);
    if (!ok) failures++;
  };

  try {
    const prisma = app.get(PrismaService);
    const products = app.get(ProductsService);

    const total = await RequestContextStore.withoutScope(() => prisma.db.product.count());
    console.log(`\n  catalogue size: ${total.toLocaleString()} products\n`);

    // `searchIds` is private on the service; the fuzzy branch is reached by
    // searching a term that full-text cannot match — i.e. a real typo.
    const search = (term: string): Promise<string[]> =>
      (products as unknown as { searchIds(t: string): Promise<string[]> }).searchIds(term);

    console.log('── Does a TYPO still find the product? (HANDOFF §4.11) ─────');
    const t0 = Date.now();
    const ids = await RequestContextStore.withoutScope(() => search('raksah'));
    const ms = Date.now() - t0;

    const names = await RequestContextStore.withoutScope(() =>
      prisma.db.product.findMany({ where: { id: { in: ids } }, select: { sku: true } }),
    );

    check(
      "'raksah' still matches the Raksha products",
      names.some((n) => n.sku.includes('RAKSHA')),
      `${ids.length} result(s) in ${ms} ms: ${names.map((n) => n.sku).slice(0, 6).join(', ')}`,
    );

    check(
      'and it is fast enough for the p95 < 300 ms target',
      ms < 300,
      `${ms} ms — the function form measured 1712 ms on this catalogue`,
    );

    console.log('\n── Does an EXACT term still work? (the common path) ────────');
    const t1 = Date.now();
    const exact = await RequestContextStore.withoutScope(() => search('Raksha'));
    check(
      'exact search unaffected',
      exact.length > 0,
      `${exact.length} result(s) in ${Date.now() - t1} ms`,
    );

    console.log('\n── Does a nonsense term return NOTHING? ────────────────────');
    const t2 = Date.now();
    const none = await RequestContextStore.withoutScope(() => search('zzzqqqxyw'));
    check(
      'no false positives',
      none.length === 0,
      `${none.length} result(s) in ${Date.now() - t2} ms — a search that matches ` +
        `everything is as broken as one that matches nothing`,
    );
  } catch (error) {
    console.error('\n  ✗ threw:', error instanceof Error ? error.message : error);
    failures++;
  } finally {
    await app.close();
  }

  console.log(failures === 0 ? '\nSearch is correct and indexed.\n' : `\n${failures} FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
