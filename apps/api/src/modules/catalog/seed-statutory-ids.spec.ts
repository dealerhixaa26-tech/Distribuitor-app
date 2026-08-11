import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gstinSchema, panSchema } from '@hixaa/contracts';

/**
 * Every statutory identifier in the seed must satisfy the validator the API
 * enforces at runtime.
 *
 * The failure this catches is quiet and expensive. `DIST-PORTAL-01` shipped
 * with `27AACCN1234F1Z8`, whose GSTIN check digit should have been `V`. Nothing
 * complained: the distributor seeded, appeared in lists, took quotations and
 * orders, and got all the way to an approved order with reserved stock. Only
 * ISSUING an invoice refused it — correctly, because a buyer cannot claim input
 * credit against a malformed GSTIN.
 *
 * So the whole sell-in path was walkable in a demo and the last step was not,
 * and nobody would have found that until UAT tried to bill someone. Cheaper to
 * assert here: the seed is fixture data for exactly the flows it was blocking.
 *
 * Reads the seed SOURCE rather than the database, so it runs in `pnpm verify`
 * with no database and catches a bad literal before it is ever seeded.
 */

const SEED_DIR = path.join(__dirname, '../../../prisma/seed');

/** Quoted string literals assigned to a `gstin:` / `pan:` property. */
const ASSIGNMENTS = /\b(gstin|pan)\s*:\s*'([^']+)'/g;

function collect(): Array<{ file: string; field: string; value: string }> {
  const found: Array<{ file: string; field: string; value: string }> = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;

      const source = readFileSync(full, 'utf8');
      for (const match of source.matchAll(ASSIGNMENTS)) {
        const [, field, value] = match;
        // Both groups are non-optional in the pattern; the guard is for the
        // type, not for a case that can occur.
        if (field && value) found.push({ file: entry.name, field, value });
      }
    }
  };

  walk(SEED_DIR);
  return found;
}

describe('seeded statutory identifiers', () => {
  const identifiers = collect();

  it('finds some to check — an empty sweep would pass vacuously', () => {
    // Without this, a rename of the seed directory turns every assertion below
    // into a no-op that reports success. Success over an empty set is the
    // defect this codebase keeps meeting (HANDOFF §2).
    expect(identifiers.length).toBeGreaterThan(0);
  });

  it.each(collect().filter((entry) => entry.field === 'gstin'))(
    'GSTIN $value in $file passes the same validator the API uses',
    ({ value }) => {
      expect(gstinSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each(collect().filter((entry) => entry.field === 'pan'))(
    'PAN $value in $file is well-formed',
    ({ value }) => {
      expect(panSchema.safeParse(value).success).toBe(true);
    },
  );

  it('keeps each GSTIN consistent with the PAN embedded in it', () => {
    // A GSTIN carries its holder's PAN at characters 3–12. Where a fixture
    // gives both and they disagree, one is a typo — and `createDistributorSchema`
    // refuses that pair, so the fixture could not be re-entered through the UI
    // it exists to exercise.
    const gstins = identifiers.filter((entry) => entry.field === 'gstin');
    const pans = new Set(
      identifiers.filter((entry) => entry.field === 'pan').map((entry) => entry.value),
    );

    for (const { value } of gstins) {
      const embedded = value.slice(2, 12);
      if (pans.has(embedded)) expect(panSchema.safeParse(embedded).success).toBe(true);
    }
  });
});
