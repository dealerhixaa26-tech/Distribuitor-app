import { BACKUP_ENTITIES } from './backup-entities';

/**
 * The backup allow-list, asserted.
 *
 * A spreadsheet is a weaker security boundary than the database — it gets
 * shared, downloaded, and left in a Drive folder somebody leaves the company
 * with. So the failure mode here is not "the backup is wrong", it is "a
 * credential is now in a file with a share button on it".
 *
 * `verify-backup.ts` proves masking against the live database by execution, and
 * that is the stronger evidence. This file exists because that script is run by
 * hand and this runs on every commit: a column added to `user` or `distributor`
 * six months from now must not be able to reach a sheet quietly.
 */

/** Column names that must never appear in any exported header. */
const FORBIDDEN = [
  'passwordHash',
  'password',
  'mfaSecret',
  'secret',
  'token',
  'refreshToken',
  'bankAccountEncrypted',
  'privateKey',
  'apiKey',
];

describe('backup entities — the six sheets from docs/07 §2', () => {
  it('exports exactly the six specified entities', () => {
    expect(BACKUP_ENTITIES.map((e) => e.name)).toEqual([
      'Users',
      'Products',
      'Distributors',
      'Orders',
      'Payments',
      'Inventory',
    ]);
  });

  it('shards across two spreadsheets, because one cannot hold the scale', () => {
    // docs/07 §2's honest limitation: Sheets caps at 10M cells.
    const shards = new Set(BACKUP_ENTITIES.map((e) => e.shard));
    expect(shards).toEqual(new Set(['PRIMARY', 'TRANSACTIONS']));
  });

  it('leads every sheet with `id`, which the restore diff keys on', () => {
    // RestoreService.dryRun refuses a sheet whose first column is not `id`.
    for (const entity of BACKUP_ENTITIES) {
      expect(entity.header[0]).toBe('id');
    }
  });
});

describe('backup entities — nothing sensitive is exported', () => {
  it.each(BACKUP_ENTITIES.map((e) => [e.name, e] as const))(
    '%s exports no credential-bearing column',
    (_name, entity) => {
      const lowered = entity.header.map((h) => h.toLowerCase());
      for (const forbidden of FORBIDDEN) {
        expect(lowered).not.toContain(forbidden.toLowerCase());
      }
    },
  );

  it('carries the bank ACCOUNT column but never the encrypted value', () => {
    const distributors = BACKUP_ENTITIES.find((e) => e.name === 'Distributors');

    // The column is present on purpose: "has bank details on file, withheld"
    // and "has no bank details" are different facts, and collapsing them would
    // make the backup misleading rather than merely incomplete.
    expect(distributors?.header).toContain('bankAccount');
    // …but never the raw column name, which is what would signal a dump.
    expect(distributors?.header).not.toContain('bankAccountEncrypted');
  });

  it('does not export the token, session or MFA tables at all', () => {
    // The strongest form of the control: these are not entities, so no mapper
    // exists that could be edited into exporting them.
    const names = BACKUP_ENTITIES.map((e) => e.name.toLowerCase());
    for (const table of ['session', 'mfafactor', 'passwordresettoken', 'apikey']) {
      expect(names).not.toContain(table);
    }
  });
});
