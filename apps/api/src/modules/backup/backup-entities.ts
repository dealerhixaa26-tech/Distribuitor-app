import type { PrismaService } from '../../infrastructure/database/prisma.service';

/**
 * What gets backed up, and — more importantly — what does not.
 *
 * The six entities are fixed by `docs/07` §2. Each declares its own header,
 * its own keyset page query and its own row mapper, because a generic
 * "serialise every column" exporter is exactly how a password hash ends up in
 * a spreadsheet: it would pick up every new column automatically, including the
 * next sensitive one somebody adds.
 *
 * ── The masking rule ───────────────────────────────────────────────────────
 *
 * A spreadsheet is a weaker security boundary than the database. It gets
 * shared, downloaded, and left in a Drive folder somebody leaves a company
 * with. So the export is an ALLOW-LIST: a column reaches a sheet only because
 * someone wrote it into a mapper below.
 *
 * Never exported, and asserted in `backup-entities.spec.ts`:
 *   • `user.password_hash` — an Argon2 hash is still a credential.
 *   • MFA secrets, session tokens, reset and verification tokens — the tables
 *     are not exported at all.
 *   • `distributor.bank_account_encrypted` — the whole point of encrypting it
 *     is that it does not sit in plaintext anywhere. The account NAME and bank
 *     are exported (useful, not secret); the number is replaced by a masked
 *     marker, never decrypted.
 *
 * GSTIN and PAN ARE exported. They are statutory identifiers that appear on
 * every invoice the distributor already holds, and a backup of a distributor
 * master without them cannot be used to reconstruct one.
 */

export interface EntityPage {
  rows: string[][];
  /** Id of the last row, for the next keyset page. Undefined when exhausted. */
  nextCursor?: string;
}

export interface BackupEntity {
  /** Sheet name. Fixed by docs/07 §2. */
  readonly name: string;
  /** Which spreadsheet it shards into — masters vs transactions. */
  readonly shard: 'PRIMARY' | 'TRANSACTIONS';
  readonly header: string[];
  /** Total rows, counted before the run so an empty export is detectable. */
  count(prisma: PrismaService): Promise<number>;
  /** One keyset page, ordered by id, strictly after `cursor`. */
  page(prisma: PrismaService, cursor: string | undefined, take: number): Promise<EntityPage>;
}

/** Decimal → string, never a JSON number (ADR-0004). */
const money = (value: { toFixed(dp: number): string } | null | undefined): string =>
  value ? value.toFixed(4) : '';

const iso = (value: Date | null | undefined): string => value?.toISOString() ?? '';
const text = (value: string | null | undefined): string => value ?? '';

/**
 * A present-but-withheld marker.
 *
 * Deliberately not an empty string: "this distributor has bank details on file
 * which are not in this backup" and "this distributor has no bank details" are
 * different facts, and a restore must not silently turn the first into the
 * second.
 */
const REDACTED = '[redacted]';
const redactIfPresent = (value: string | null | undefined): string => (value ? REDACTED : '');

export const BACKUP_ENTITIES: readonly BackupEntity[] = [
  {
    name: 'Users',
    shard: 'PRIMARY',
    header: ['id', 'email', 'firstName', 'lastName', 'status', 'mfaEnabled', 'lastLoginAt', 'createdAt'],
    count: (prisma) => prisma.db.user.count(),
    async page(prisma, cursor, take) {
      const rows = await prisma.db.user.findMany({
        where: cursor ? { id: { gt: cursor } } : undefined,
        orderBy: { id: 'asc' },
        take,
        // An explicit select, not `include`. A new sensitive column added to
        // `user` must not silently start being exported.
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          status: true,
          mfaEnabled: true,
          lastLoginAt: true,
          createdAt: true,
        },
      });
      return {
        rows: rows.map((u) => [
          u.id,
          u.email,
          u.firstName,
          u.lastName,
          u.status,
          String(u.mfaEnabled),
          iso(u.lastLoginAt),
          iso(u.createdAt),
        ]),
        nextCursor: rows.at(-1)?.id,
      };
    },
  },

  {
    name: 'Products',
    shard: 'PRIMARY',
    header: ['id', 'sku', 'name', 'type', 'status', 'hsnCode', 'sacCode', 'gstRate', 'createdAt'],
    count: (prisma) => prisma.db.product.count(),
    async page(prisma, cursor, take) {
      const rows = await prisma.db.product.findMany({
        where: cursor ? { id: { gt: cursor } } : undefined,
        orderBy: { id: 'asc' },
        take,
        select: {
          id: true,
          sku: true,
          name: true,
          type: true,
          status: true,
          hsnCode: true,
          sacCode: true,
          gstRate: true,
          createdAt: true,
        },
      });
      return {
        rows: rows.map((p) => [
          p.id,
          p.sku,
          p.name,
          p.type,
          p.status,
          text(p.hsnCode),
          text(p.sacCode),
          money(p.gstRate),
          iso(p.createdAt),
        ]),
        nextCursor: rows.at(-1)?.id,
      };
    },
  },

  {
    name: 'Distributors',
    shard: 'PRIMARY',
    header: [
      'id',
      'code',
      'legalName',
      'tradeName',
      'status',
      'gstin',
      'pan',
      'creditLimit',
      'bankName',
      'bankAccountName',
      'bankIfsc',
      'bankAccount',
      'createdAt',
    ],
    count: (prisma) => prisma.db.distributor.count(),
    async page(prisma, cursor, take) {
      const rows = await prisma.db.distributor.findMany({
        where: cursor ? { id: { gt: cursor } } : undefined,
        orderBy: { id: 'asc' },
        take,
        select: {
          id: true,
          code: true,
          legalName: true,
          tradeName: true,
          status: true,
          gstin: true,
          pan: true,
          creditLimit: true,
          bankName: true,
          bankAccountName: true,
          bankIfsc: true,
          // Selected ONLY to know whether one exists. It is never decrypted and
          // never written — see `redactIfPresent`.
          bankAccountEncrypted: true,
          createdAt: true,
        },
      });
      return {
        rows: rows.map((d) => [
          d.id,
          d.code,
          d.legalName,
          text(d.tradeName),
          d.status,
          text(d.gstin),
          text(d.pan),
          money(d.creditLimit),
          text(d.bankName),
          text(d.bankAccountName),
          text(d.bankIfsc),
          redactIfPresent(d.bankAccountEncrypted),
          iso(d.createdAt),
        ]),
        nextCursor: rows.at(-1)?.id,
      };
    },
  },

  {
    name: 'Orders',
    shard: 'TRANSACTIONS',
    header: [
      'id',
      'number',
      'status',
      'orderDate',
      'distributorId',
      'customerId',
      'subtotal',
      'totalTax',
      'grandTotal',
      'createdAt',
    ],
    count: (prisma) => prisma.db.order.count(),
    async page(prisma, cursor, take) {
      const rows = await prisma.db.order.findMany({
        where: cursor ? { id: { gt: cursor } } : undefined,
        orderBy: { id: 'asc' },
        take,
        select: {
          id: true,
          number: true,
          status: true,
          orderDate: true,
          distributorId: true,
          customerId: true,
          subtotal: true,
          totalTax: true,
          grandTotal: true,
          createdAt: true,
        },
      });
      return {
        rows: rows.map((o) => [
          o.id,
          o.number,
          o.status,
          iso(o.orderDate),
          text(o.distributorId),
          text(o.customerId),
          money(o.subtotal),
          money(o.totalTax),
          money(o.grandTotal),
          iso(o.createdAt),
        ]),
        nextCursor: rows.at(-1)?.id,
      };
    },
  },

  {
    name: 'Payments',
    shard: 'TRANSACTIONS',
    header: [
      'id',
      'number',
      'status',
      'paymentDate',
      'method',
      'amount',
      'distributorId',
      'customerId',
      'referenceNumber',
      'createdAt',
    ],
    count: (prisma) => prisma.db.payment.count(),
    async page(prisma, cursor, take) {
      const rows = await prisma.db.payment.findMany({
        where: cursor ? { id: { gt: cursor } } : undefined,
        orderBy: { id: 'asc' },
        take,
        select: {
          id: true,
          number: true,
          status: true,
          paymentDate: true,
          method: true,
          amount: true,
          distributorId: true,
          customerId: true,
          referenceNumber: true,
          createdAt: true,
        },
      });
      return {
        rows: rows.map((p) => [
          p.id,
          p.number,
          p.status,
          iso(p.paymentDate),
          p.method,
          money(p.amount),
          text(p.distributorId),
          text(p.customerId),
          text(p.referenceNumber),
          iso(p.createdAt),
        ]),
        nextCursor: rows.at(-1)?.id,
      };
    },
  },

  {
    name: 'Inventory',
    shard: 'TRANSACTIONS',
    header: [
      'id',
      'warehouseId',
      'productId',
      'batchId',
      'quantityOnHand',
      'quantityReserved',
      'quantityAvailable',
      'averageCost',
      'updatedAt',
    ],
    count: (prisma) => prisma.db.stockBalance.count(),
    async page(prisma, cursor, take) {
      const rows = await prisma.db.stockBalance.findMany({
        where: cursor ? { id: { gt: cursor } } : undefined,
        orderBy: { id: 'asc' },
        take,
        select: {
          id: true,
          warehouseId: true,
          productId: true,
          batchId: true,
          quantityOnHand: true,
          quantityReserved: true,
          quantityAvailable: true,
          averageCost: true,
          updatedAt: true,
        },
      });
      return {
        rows: rows.map((b) => [
          b.id,
          b.warehouseId,
          b.productId,
          text(b.batchId),
          money(b.quantityOnHand),
          money(b.quantityReserved),
          money(b.quantityAvailable),
          money(b.averageCost),
          iso(b.updatedAt),
        ]),
        nextCursor: rows.at(-1)?.id,
      };
    },
  },
];

export const REDACTED_MARKER = REDACTED;
