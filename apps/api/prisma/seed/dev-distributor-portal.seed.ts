import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

/**
 * A DISTRIBUTOR-scoped portal account, for exercising ADR-0003's scope
 * machinery from the outside.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * ADR-0003 scopes authorization at the repository layer specifically so the
 * future Distributor Portal is "a frontend project rather than a backend
 * rewrite". `permissions.seed.ts` already seeds DISTRIBUTOR_OWNER and
 * DISTRIBUTOR_STAFF for the same reason — so the machinery is exercised long
 * before the portal UI exists.
 *
 * This adds the missing half: a real distributor with a real login, so that
 * claim can be TESTED rather than asserted. Until Phase 10, every scoped
 * control in this project that was assumed to work and never exercised turned
 * out to be broken.
 *
 * ⚠️ THERE IS NO PORTAL UI. `apps/web` has `(auth)` and `(dashboard)` only.
 * This account authenticates and is correctly scoped at the API, but signing in
 * lands on the internal DMS dashboard, where DISTRIBUTOR_OWNER holds almost
 * none of the permissions the navigation expects. That is the honest state of
 * things, not a bug in this seed.
 *
 * Dev only — skipped in production, exactly like `dev-users.seed.ts`.
 */

const PORTAL_DISTRIBUTOR = {
  code: 'DIST-PORTAL-01',
  legalName: 'Nagpur Industrial Automation Pvt Ltd',
  tradeName: 'Nagpur Automation',
  territoryName: 'Maharashtra',
  gstin: '27AACCN1234F1Z8',
  pan: 'AACCN1234F',
  creditLimit: '500000.0000',
  creditDays: 30,
};

const PORTAL_USER = {
  email: 'portal@nagpurautomation.test',
  password: 'portal-nagpur-2026',
  firstName: 'Nagpur',
  lastName: 'Portal',
};

export async function seedDevDistributorPortal(prisma: PrismaClient): Promise<void> {
  console.log('\n› Distributor portal account (dev only)');

  if (process.env.NODE_ENV === 'production') {
    console.log('  – Skipped in production');
    return;
  }

  const territory = await prisma.territory.findFirst({
    where: { name: PORTAL_DISTRIBUTOR.territoryName },
    select: { id: true },
  });
  if (!territory) {
    console.log(`  – Skipped: territory ${PORTAL_DISTRIBUTOR.territoryName} not found`);
    return;
  }

  // Idempotent, like every other seed here: re-running must not duplicate.
  let distributor = await prisma.distributor.findUnique({
    where: { code: PORTAL_DISTRIBUTOR.code },
    select: { id: true, code: true },
  });

  if (!distributor) {
    distributor = await prisma.distributor.create({
      data: {
        code: PORTAL_DISTRIBUTOR.code,
        legalName: PORTAL_DISTRIBUTOR.legalName,
        tradeName: PORTAL_DISTRIBUTOR.tradeName,
        status: 'ACTIVE',
        territoryId: territory.id,
        gstin: PORTAL_DISTRIBUTOR.gstin,
        pan: PORTAL_DISTRIBUTOR.pan,
        creditLimit: PORTAL_DISTRIBUTOR.creditLimit,
        creditDays: PORTAL_DISTRIBUTOR.creditDays,
        onboardedAt: new Date(),
      },
      select: { id: true, code: true },
    });
    console.log(`  ✓ Created distributor ${distributor.code}`);
  } else {
    console.log(`  – Distributor ${distributor.code} already exists`);
  }

  // A contact, because `approve()` refuses a distributor with none — and
  // because the quotation and invoice mail handlers resolve recipients through
  // the contact tables (neither distributor nor customer carries an email).
  const contacts = await prisma.distributorContact.count({
    where: { distributorId: distributor.id },
  });
  if (contacts === 0) {
    await prisma.distributorContact.create({
      data: {
        distributorId: distributor.id,
        name: 'Nagpur Portal Contact',
        email: PORTAL_USER.email,
        isPrimary: true,
      },
    });
    console.log('  ✓ Created primary contact');
  }

  const existing = await prisma.user.findUnique({
    where: { email: PORTAL_USER.email },
    select: { id: true },
  });
  if (existing) {
    console.log(`  – User ${PORTAL_USER.email} already exists`);
    return;
  }

  const role = await prisma.role.findUnique({
    where: { key: 'DISTRIBUTOR_OWNER' },
    select: { id: true },
  });
  if (!role) {
    console.log('  – Skipped: DISTRIBUTOR_OWNER role not found (run the permissions seed)');
    return;
  }

  const passwordHash = await argon2.hash(PORTAL_USER.password, {
    type: argon2.argon2id,
    memoryCost: Number(process.env.ARGON2_MEMORY_COST ?? 65_536),
    timeCost: Number(process.env.ARGON2_TIME_COST ?? 3),
    parallelism: Number(process.env.ARGON2_PARALLELISM ?? 4),
  });

  await prisma.user.create({
    data: {
      email: PORTAL_USER.email,
      passwordHash,
      firstName: PORTAL_USER.firstName,
      lastName: PORTAL_USER.lastName,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      // False for the same reason as the other dev accounts: a forced change
      // would break every scripted check that signs in as this user.
      mustChangePassword: false,
      roles: {
        create: {
          roleId: role.id,
          // The whole point: scoped to ONE distributor, so the scope extension
          // has something real to refuse.
          scopeType: 'DISTRIBUTOR',
          scopeId: distributor.id,
        },
      },
    },
  });

  console.log(`  ✓ Created ${PORTAL_USER.email} scoped to ${distributor.code}`);

  /*
   * One order belonging to this distributor.
   *
   * Without it the portal account sees an empty list — and an empty list is
   * exactly what a BROKEN scope looks like (ADR-0021: every background job
   * read `id IN ()` for three phases while reporting success). A fixture that
   * cannot tell "correctly scoped" from "silently returning nothing" is not a
   * fixture worth having.
   */
  const orderExists = await prisma.order.findFirst({
    where: { number: 'SO-PORTAL-0001' },
    select: { id: true },
  });
  if (!orderExists) {
    await prisma.order.create({
      data: {
        number: 'SO-PORTAL-0001',
        orderDate: new Date(),
        type: 'PRIMARY',
        status: 'APPROVED',
        distributorId: distributor.id,
        subtotal: '100000.0000',
        taxableValue: '100000.0000',
        totalTax: '18000.0000',
        grandTotal: '118000.0000',
      },
    });
    console.log('  ✓ Created SO-PORTAL-0001 so the scope is demonstrable, not just empty');
  }
}
