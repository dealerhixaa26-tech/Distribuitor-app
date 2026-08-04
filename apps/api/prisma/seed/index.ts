import path from 'node:path';
import { financialYearOf, ROLE_KEYS } from '@hixaa/contracts';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { config as loadEnv } from 'dotenv';
import { seedCatalog } from './catalog.seed';
import { seedGeography, seedIndustries, seedTerritories } from './geography.seed';
import { seedPermissions, seedRoles } from './permissions.seed';
import { seedPortfolio } from './portfolio.seed';

loadEnv({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });

const prisma = new PrismaClient();

/**
 * Idempotent seeds, safe to run on every deploy.
 *
 * Split by intent:
 *   • system    — permissions, roles, number sequences. Runs in production.
 *   • portfolio — Hixaa's company profile and service lines. Runs in production.
 *   • bootstrap — the first super admin. Runs once, then no-ops.
 *   • demo      — synthetic data. NEVER in production; guarded below.
 */
async function main(): Promise<void> {
  const env = process.env.NODE_ENV ?? 'development';
  console.log(`\n▶ Seeding Hixaa DMS  [${env}]\n`);

  console.log('› Permissions');
  await seedPermissions(prisma);

  console.log('\n› Roles');
  await seedRoles(prisma);

  console.log('\n› Geography');
  await seedGeography(prisma);

  console.log('\n› Industries');
  await seedIndustries(prisma);

  console.log('\n› Territories');
  await seedTerritories(prisma);

  console.log('\n› Company profile & portfolio');
  await seedPortfolio(prisma);

  console.log('\n› Catalog (categories, products, prices, tax rates)');
  await seedCatalog(prisma);

  console.log('\n› Number sequences');
  await seedNumberSequences();

  console.log('\n› Bootstrap administrator');
  await seedSuperAdmin();

  console.log('\n✅ Seed complete\n');
}

/**
 * Statutory and business number series.
 *
 * Invoice numbering resets each Indian financial year and must be gapless —
 * gaps in a GST series invite scrutiny. The sequence is allocated inside the
 * invoicing transaction with SELECT … FOR UPDATE, so a rolled-back transaction
 * never burns a number.
 */
async function seedNumberSequences(): Promise<void> {
  const fy = financialYearOf(new Date());
  const invoicePrefix = process.env.INVOICE_NUMBER_PREFIX ?? 'HTPL/INV';
  const orderPrefix = process.env.ORDER_NUMBER_PREFIX ?? 'SO';

  const sequences = [
    { key: `INVOICE:${fy}`, prefix: `${invoicePrefix}/${fy}`, padding: 5, resetPolicy: 'YEARLY' as const, financialYear: fy },
    { key: `ORDER:${fy}`, prefix: `${orderPrefix}/${fy}`, padding: 5, resetPolicy: 'YEARLY' as const, financialYear: fy },
    { key: `QUOTATION:${fy}`, prefix: `QT/${fy}`, padding: 5, resetPolicy: 'YEARLY' as const, financialYear: fy },
    { key: `SHIPMENT:${fy}`, prefix: `DC/${fy}`, padding: 5, resetPolicy: 'YEARLY' as const, financialYear: fy },
    { key: `PAYMENT:${fy}`, prefix: `RCPT/${fy}`, padding: 5, resetPolicy: 'YEARLY' as const, financialYear: fy },
    // Distributor and customer codes run continuously, not per year.
    { key: 'DISTRIBUTOR', prefix: 'DIST', padding: 5, resetPolicy: 'NEVER' as const, financialYear: null },
    { key: 'CUSTOMER', prefix: 'CUST', padding: 5, resetPolicy: 'NEVER' as const, financialYear: null },
  ];

  for (const sequence of sequences) {
    await prisma.numberSequence.upsert({
      where: { key: sequence.key },
      create: sequence,
      // Never reset `nextValue` on an existing sequence — that would reissue
      // numbers already printed on legal documents.
      update: { prefix: sequence.prefix, padding: sequence.padding },
    });
  }

  console.log(`  ✓ ${sequences.length} sequences (FY ${fy})`);
}

/**
 * Creates the first super admin, once.
 *
 * The account is forced to change its password on first sign-in, so the value
 * in .env is never a long-lived credential.
 */
async function seedSuperAdmin(): Promise<void> {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL?.toLowerCase();
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;

  if (!email || !password) {
    console.log('  – Skipped (SEED_SUPER_ADMIN_EMAIL/PASSWORD not set)');
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    console.log(`  – Already exists: ${email}`);
    return;
  }

  if (process.env.NODE_ENV === 'production' && password.includes('ChangeMe')) {
    throw new Error(
      'SEED_SUPER_ADMIN_PASSWORD is still the placeholder. Set a real password before seeding production.',
    );
  }

  const role = await prisma.role.findUnique({
    where: { key: ROLE_KEYS.SUPER_ADMIN },
    select: { id: true },
  });
  if (!role) throw new Error('SUPER_ADMIN role missing — seed roles first');

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: Number(process.env.ARGON2_MEMORY_COST ?? 65_536),
    timeCost: Number(process.env.ARGON2_TIME_COST ?? 3),
    parallelism: Number(process.env.ARGON2_PARALLELISM ?? 4),
  });

  await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName: 'Super',
      lastName: 'Admin',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      mustChangePassword: true,
      roles: { create: { roleId: role.id, scopeType: 'GLOBAL', scopeId: null } },
    },
  });

  console.log(`  ✓ Created ${email} (must change password on first sign-in)`);
}

main()
  .catch((error) => {
    console.error('\n❌ Seed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
