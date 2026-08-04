import type { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

/**
 * Dev-only accounts that exist to test DENIAL. Never seeded in production.
 *
 * HANDOFF §4.4: *a security control is not verified until something is
 * REFUSED*. These accounts are how that is done, and until Phase 6 they lived
 * only in whichever database someone had created them in by hand — so a fresh
 * clone could not reproduce the denial tests at all.
 *
 * ── Why the third account exists ───────────────────────────────────────────
 * `west.manager` is territory-scoped but holds READ-ONLY inventory permissions.
 * That meant every attempted out-of-scope WRITE returned 403 on permission
 * grounds, which says nothing about whether row scoping guards writes — the two
 * controls are independent.
 *
 * That blind spot hid a real bug for two phases: the scope extension composed
 * `update`/`delete` predicates into a shape Prisma rejects, so EVERY scoped
 * update 500'd for a non-global caller — including editing a distributor, which
 * `west.manager` genuinely has permission to do. A GLOBAL caller short-circuits
 * the code path entirely, so no admin-token test could ever have found it.
 *
 * `west.storekeeper` closes the gap: territory-scoped AND holding inventory
 * write permissions, so a refusal from that account is unambiguously a SCOPE
 * refusal. Keep an account of this shape for every new scoped module.
 */
interface DevUserSeed {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  roleKey: string;
  /** Territory name to scope to, or null for GLOBAL. */
  territoryName: string | null;
  purpose: string;
}

const DEV_USERS: DevUserSeed[] = [
  {
    email: 'west.manager@hixaa.test',
    password: 'vidarbha-automation-2026',
    firstName: 'West',
    lastName: 'Manager',
    roleKey: 'SALES_MANAGER',
    territoryName: 'West Zone',
    purpose: 'Territory-scoped READS — proves row scoping filters what is visible.',
  },
  {
    email: 'support@hixaa.test',
    password: 'correct-horse-battery-staple',
    firstName: 'Support',
    lastName: 'Agent',
    roleKey: 'SUPPORT_AGENT',
    territoryName: null,
    purpose: 'Global but low-permission — proves PERMISSION denial independently of scope.',
  },
  {
    email: 'west.storekeeper@hixaa.test',
    password: 'storekeeper-nagpur-2026',
    firstName: 'West',
    lastName: 'Storekeeper',
    roleKey: 'INVENTORY_MANAGER',
    territoryName: 'West Zone',
    purpose:
      'Territory-scoped AND holds inventory WRITE permissions — the only account that can ' +
      'prove scope guards writes rather than permissions masking the test.',
  },
  {
    email: 'west.accountant@hixaa.test',
    password: 'accounts-vidarbha-2026',
    firstName: 'West',
    lastName: 'Accountant',
    roleKey: 'ACCOUNTS_EXECUTIVE',
    territoryName: 'West Zone',
    purpose:
      'Phase 8’s account of the same shape: territory-scoped AND holding finance WRITE ' +
      'permissions, so an out-of-zone invoice or payment write refuses on SCOPE grounds. ' +
      'Also the counterparty for the segregation test — it records receipts that a ' +
      'different account must verify (ADR-0018).',
  },
  {
    email: 'finance.manager@hixaa.test',
    password: 'finance-nagpur-2026',
    firstName: 'Finance',
    lastName: 'Manager',
    roleKey: 'FINANCE_MANAGER',
    territoryName: null,
    purpose:
      'Holds PAYMENT_VERIFY and INVOICE_ISSUE, which ACCOUNTS_EXECUTIVE deliberately does not. ' +
      'The segregation in ADR-0018 needs TWO accounts to demonstrate at all: one to record a ' +
      'receipt and a different one to confirm it.',
  },
];

export async function seedDevUsers(prisma: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.log('  – Skipped in production');
    return;
  }

  let created = 0;
  for (const seed of DEV_USERS) {
    const existing = await prisma.user.findUnique({
      where: { email: seed.email },
      select: { id: true },
    });
    if (existing) continue;

    const role = await prisma.role.findUnique({
      where: { key: seed.roleKey },
      select: { id: true },
    });
    if (!role) {
      console.log(`  – Skipped ${seed.email}: role ${seed.roleKey} not found`);
      continue;
    }

    let scopeId: string | null = null;
    if (seed.territoryName) {
      const territory = await prisma.territory.findFirst({
        where: { name: seed.territoryName },
        select: { id: true },
      });
      if (!territory) {
        console.log(`  – Skipped ${seed.email}: territory ${seed.territoryName} not found`);
        continue;
      }
      scopeId = territory.id;
    }

    const passwordHash = await argon2.hash(seed.password, {
      type: argon2.argon2id,
      memoryCost: Number(process.env.ARGON2_MEMORY_COST ?? 65_536),
      timeCost: Number(process.env.ARGON2_TIME_COST ?? 3),
      parallelism: Number(process.env.ARGON2_PARALLELISM ?? 4),
    });

    await prisma.user.create({
      data: {
        email: seed.email,
        passwordHash,
        firstName: seed.firstName,
        lastName: seed.lastName,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        // Deliberately false: these are automated-test accounts, and a forced
        // password change would break every scripted denial check.
        mustChangePassword: false,
        roles: {
          create: {
            roleId: role.id,
            scopeType: scopeId ? 'TERRITORY' : 'GLOBAL',
            scopeId,
          },
        },
      },
    });
    created++;
  }

  console.log(`  ✓ ${DEV_USERS.length} denial-test accounts (${created} new)`);
}
