import { Injectable } from '@nestjs/common';
import {
  Money,
  OUTSTANDING_INVOICE_STATUSES,
  agingBucketFor,
  daysPastDue,
  type AgingBucket,
  type LedgerPartyType,
  type ListOutstandingQuery,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/**
 * Outstanding receivables, aged.
 *
 * ── Aging runs from the DUE date, not the invoice date ─────────────────────
 * An invoice on Net 45 terms is not overdue on day 31. Aging from the invoice
 * date is the common shortcut and it produces a report that shows healthy
 * accounts as delinquent, which is worse than no report — people stop trusting
 * it and then stop reading it.
 *
 * ── Overdue is computed, never stored ──────────────────────────────────────
 * There is no `OVERDUE` status and no nightly job that sets one. `dueDate` and
 * `amountOutstanding` are both on the row, so the question is answerable at
 * read time and is therefore never stale (docs/23 §5).
 */
@Injectable()
export class OutstandingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OutstandingService.name);
  }

  /**
   * The aging report.
   *
   * Buckets are accumulated in TypeScript rather than by a grouped SQL query
   * with a CASE expression. The date arithmetic that decides a bucket is the
   * part most likely to be wrong, and `bucketForInvoice` is the same function
   * the invoice detail uses and unit tests cover — one implementation, tested
   * once, rather than a second one living in SQL where no test reaches it.
   *
   * The row count is bounded by unsettled invoices, which is a working set of
   * hundreds, not millions.
   */
  async report(query: ListOutstandingQuery) {
    const asOf = query.asOf ? new Date(`${query.asOf}T00:00:00.000Z`) : this.clock.now();

    const where: Prisma.InvoiceWhereInput = {
      status: { in: [...OUTSTANDING_INVOICE_STATUSES] },
      amountOutstanding: { gt: 0 },
      ...(query.distributorId ? { distributorId: query.distributorId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.partyType === 'DISTRIBUTOR' ? { distributorId: { not: null } } : {}),
      ...(query.partyType === 'CUSTOMER' ? { customerId: { not: null } } : {}),
    };

    const invoices = await this.prisma.db.invoice.findMany({
      where,
      select: {
        id: true,
        number: true,
        dueDate: true,
        amountOutstanding: true,
        distributorId: true,
        customerId: true,
        distributor: { select: { legalName: true, code: true, creditLimit: true } },
        customer: { select: { name: true, code: true } },
      },
    });

    const parties = new Map<string, PartyAccumulator>();

    for (const invoice of invoices) {
      const partyType: LedgerPartyType = invoice.distributorId ? 'DISTRIBUTOR' : 'CUSTOMER';
      const partyId = invoice.distributorId ?? invoice.customerId;
      if (!partyId) continue;

      const key = `${partyType}:${partyId}`;
      let party = parties.get(key);
      if (!party) {
        party = {
          partyType,
          partyId,
          partyName: invoice.distributor?.legalName ?? invoice.customer?.name ?? 'Unknown',
          partyCode: invoice.distributor?.code ?? invoice.customer?.code ?? null,
          creditLimit: invoice.distributor
            ? Money.of(invoice.distributor.creditLimit.toFixed(4))
            : null,
          buckets: emptyBuckets(),
          invoiceCount: 0,
          overdueInvoiceCount: 0,
          oldestDaysPastDue: 0,
        };
        parties.set(key, party);
      }

      const dueDate = invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : null;
      const outstanding = Money.of(invoice.amountOutstanding.toFixed(4));
      const past = daysPastDue(dueDate, asOf);
      const bucket = agingBucketFor(past);

      party.buckets[bucket] = party.buckets[bucket].add(outstanding);
      party.invoiceCount += 1;
      if (past > 0) {
        party.overdueInvoiceCount += 1;
        party.oldestDaysPastDue = Math.max(party.oldestDaysPastDue, past);
      }
    }

    let rows = [...parties.values()];
    if (query.overdueOnly) {
      rows = rows.filter((party) => party.overdueInvoiceCount > 0);
    }

    // Worst first — the report exists to drive a collections call, and the
    // party with the oldest debt is the call to make.
    rows.sort((a, b) => b.oldestDaysPastDue - a.oldestDaysPastDue);

    const totals = emptyBuckets();
    for (const party of rows) {
      for (const bucket of BUCKET_KEYS) {
        totals[bucket] = totals[bucket].add(party.buckets[bucket]);
      }
    }

    return {
      asOf: asOf.toISOString().slice(0, 10),
      parties: rows.map((party) => {
        const total = sumBuckets(party.buckets);
        return {
          partyType: party.partyType,
          partyId: party.partyId,
          partyName: party.partyName,
          partyCode: party.partyCode,
          ...serialiseBuckets(party.buckets, total),
          invoiceCount: party.invoiceCount,
          overdueInvoiceCount: party.overdueInvoiceCount,
          oldestDaysPastDue: party.oldestDaysPastDue,
          creditLimit: party.creditLimit?.toString() ?? null,
          creditUtilisationPercent:
            party.creditLimit && party.creditLimit.isPositive()
              ? total.multiply(100).divide(party.creditLimit.toString()).round(2).toString()
              : null,
        };
      }),
      totals: serialiseBuckets(totals, sumBuckets(totals)),
    };
  }

  /**
   * Total outstanding for one party — the term `checkCredit` adds to exposure.
   *
   * Reads `amountOutstanding` rather than summing the ledger: the ledger
   * includes write-offs and adjustments that are not a live receivable against
   * a specific document, and credit exposure is about unpaid invoices.
   */
  async outstandingFor(partyType: LedgerPartyType, partyId: string): Promise<Money> {
    const result = await this.prisma.db.invoice.aggregate({
      where: {
        ...(partyType === 'DISTRIBUTOR' ? { distributorId: partyId } : { customerId: partyId }),
        status: { in: [...OUTSTANDING_INVOICE_STATUSES] },
      },
      _sum: { amountOutstanding: true },
    });
    return Money.of(result._sum.amountOutstanding?.toFixed(4) ?? '0');
  }

  /** The invoices behind one party's balance, oldest first. */
  async invoicesFor(partyType: LedgerPartyType, partyId: string, asOfDate?: string) {
    const asOf = asOfDate ? new Date(`${asOfDate}T00:00:00.000Z`) : this.clock.now();

    const invoices = await this.prisma.db.invoice.findMany({
      where: {
        ...(partyType === 'DISTRIBUTOR' ? { distributorId: partyId } : { customerId: partyId }),
        status: { in: [...OUTSTANDING_INVOICE_STATUSES] },
        amountOutstanding: { gt: 0 },
      },
      orderBy: [{ dueDate: 'asc' }, { invoiceDate: 'asc' }],
      select: {
        id: true,
        number: true,
        invoiceDate: true,
        dueDate: true,
        grandTotal: true,
        amountPaid: true,
        amountCredited: true,
        amountOutstanding: true,
        status: true,
      },
    });

    return invoices.map((invoice) => {
      const dueDate = invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : null;
      const past = daysPastDue(dueDate, asOf);
      return {
        id: invoice.id,
        number: invoice.number,
        invoiceDate: invoice.invoiceDate.toISOString().slice(0, 10),
        dueDate,
        status: invoice.status,
        grandTotal: invoice.grandTotal.toFixed(4),
        amountPaid: invoice.amountPaid.toFixed(4),
        amountCredited: invoice.amountCredited.toFixed(4),
        amountOutstanding: invoice.amountOutstanding.toFixed(4),
        daysPastDue: Math.max(0, past),
        bucket: agingBucketFor(past),
        isOverdue: past > 0,
      };
    });
  }
}

// ── Bucket plumbing ─────────────────────────────────────────────────────────

const BUCKET_KEYS: readonly AgingBucket[] = [
  'CURRENT',
  'D0_30',
  'D31_60',
  'D61_90',
  'D90_PLUS',
];

type Buckets = Record<AgingBucket, Money>;

interface PartyAccumulator {
  partyType: LedgerPartyType;
  partyId: string;
  partyName: string;
  partyCode: string | null;
  creditLimit: Money | null;
  buckets: Buckets;
  invoiceCount: number;
  overdueInvoiceCount: number;
  oldestDaysPastDue: number;
}

const emptyBuckets = (): Buckets => ({
  CURRENT: Money.zero(),
  D0_30: Money.zero(),
  D31_60: Money.zero(),
  D61_90: Money.zero(),
  D90_PLUS: Money.zero(),
});

const sumBuckets = (buckets: Buckets): Money =>
  BUCKET_KEYS.reduce((total, key) => total.add(buckets[key]), Money.zero());

const serialiseBuckets = (buckets: Buckets, total: Money) => ({
  current: buckets.CURRENT.toString(),
  d0_30: buckets.D0_30.toString(),
  d31_60: buckets.D31_60.toString(),
  d61_90: buckets.D61_90.toString(),
  d90Plus: buckets.D90_PLUS.toString(),
  total: total.toString(),
});
