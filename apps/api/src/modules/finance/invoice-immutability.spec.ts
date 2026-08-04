import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';

/**
 * ADR-0016's stated mitigation, made real.
 *
 * The immutability guarantee lives in a database trigger, which is invisible to
 * anyone reading only TypeScript. The failure mode that creates is specific and
 * quiet: someone adds a money column to `Invoice`, forgets the trigger's column
 * list, and the NEW column is editable on an issued invoice while every old one
 * is frozen. Nothing breaks loudly. The document is simply no longer immutable
 * in the way the ADR claims.
 *
 * So the ADR promised a test that reads the trigger's column list back out of
 * the migration and compares it against the model. This is that test. It is
 * deliberately a build-time check rather than an integration test — it needs no
 * database, so it runs in the same `pnpm verify` that everything else does.
 */

const MIGRATIONS_DIR = path.join(__dirname, '../../../prisma/migrations');

/** Money and identity columns that MUST be frozen once an invoice is issued. */
const SETTLEMENT_COLUMNS = new Set([
  // Deliberately writable — this is the history of the claim, not the claim.
  // See ADR-0016 §2.
  'amount_paid',
  'amount_credited',
  'amount_outstanding',
]);

function readTriggerFunction(name: string): string {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((entry) => !entry.endsWith('.toml'));
  for (const dir of dirs) {
    const file = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
    let sql: string;
    try {
      sql = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
    if (start === -1) continue;
    const end = sql.indexOf('$$ LANGUAGE plpgsql;', start);
    return sql.slice(start, end);
  }
  throw new Error(`Trigger function ${name} was not found in any migration`);
}

/** The `NEW."col" IS DISTINCT FROM OLD."col"` comparisons the guard performs. */
function guardedColumns(functionBody: string): Set<string> {
  const guarded = new Set<string>();
  const pattern = /NEW\."([a-z_]+)"\s+IS DISTINCT FROM\s+OLD\."\1"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(functionBody)) !== null) {
    if (match[1]) guarded.add(match[1]);
  }
  return guarded;
}

/** `Invoice` money columns as the database names them. */
function invoiceDecimalColumns(): string[] {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Invoice');
  if (!model) throw new Error('Invoice model missing from the Prisma schema');

  return model.fields
    .filter((field) => field.type === 'Decimal')
    .map((field) => field.dbName ?? field.name);
}

describe('ADR-0016 — an issued invoice is frozen by the database', () => {
  const body = readTriggerFunction('invoice_is_immutable_once_issued');
  const guarded = guardedColumns(body);

  it('guards every money column on Invoice except the settlement three', () => {
    const unguarded = invoiceDecimalColumns().filter(
      (column) => !guarded.has(column) && !SETTLEMENT_COLUMNS.has(column),
    );

    if (unguarded.length > 0) {
      // Thrown rather than asserted so the failure carries the remedy. Jest's
      // `expect` takes no message argument, and `toEqual([])` alone would print
      // the column names without saying what to do about them.
      throw new Error(
        `These money columns on Invoice are NOT frozen once the invoice is issued:\n` +
          `  ${unguarded.join(', ')}\n\n` +
          `Add them to invoice_is_immutable_once_issued() in a new migration, or — if the ` +
          `column genuinely describes settlement rather than the claim itself — add it to ` +
          `SETTLEMENT_COLUMNS in this file with a reason. See ADR-0016 §1 and §2.`,
      );
    }
    expect(unguarded).toEqual([]);
  });

  it('leaves the settlement columns writable — an unpayable invoice is unusable', () => {
    const wronglyFrozen = [...SETTLEMENT_COLUMNS].filter((column) => guarded.has(column));
    // An invoice whose paid amount can never change is not immutable, it is
    // unusable (ADR-0016 §2).
    expect(wronglyFrozen).toEqual([]);
  });

  it('guards the identity fields a reader would recognise as the document', () => {
    // Not derived from the model: these are the ones Rule 46 puts on the face
    // of the invoice, and freezing them is the point of the whole exercise.
    const mustFreeze = [
      'number',
      'invoice_date',
      'due_date',
      'place_of_supply_state_code',
      'supplier_state_code',
      'distributor_id',
      'customer_id',
      'counterparty_gstin',
      'supply_type',
      'is_reverse_charge',
    ];
    expect(mustFreeze.filter((column) => !guarded.has(column))).toEqual([]);
  });

  it('only relaxes the guard for a DRAFT', () => {
    expect(body).toContain("OLD.\"status\" = 'DRAFT'");
    expect(body).toContain('RETURN NEW');
  });

  it('raises a restrict_violation rather than failing silently', () => {
    expect(body).toContain('RAISE EXCEPTION');
    expect(body).toContain("ERRCODE = 'restrict_violation'");
  });
});

describe('ADR-0015 — the party ledger is append-only', () => {
  const body = readTriggerFunction('ledger_entry_is_append_only');

  it('refuses both UPDATE and DELETE unconditionally', () => {
    // No branch: there is no state in which editing a ledger row is correct.
    expect(body).toContain('RAISE EXCEPTION');
    expect(body).not.toContain('RETURN NEW');
  });

  it('names the remedy in the error, so the caller knows what to do instead', () => {
    expect(body.toLowerCase()).toContain('contra');
  });
});

describe('the delete guards migration 0011 added', () => {
  const body = readTriggerFunction('issued_document_is_undeletable');

  it('permits deleting a DRAFT and refuses anything else', () => {
    expect(body).toContain("OLD.\"status\" <> 'DRAFT'");
    expect(body).toContain('RAISE EXCEPTION');
    expect(body).toContain('RETURN OLD');
  });
});
