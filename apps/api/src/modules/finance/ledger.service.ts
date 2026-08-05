import { Injectable } from '@nestjs/common';
import {
  LEDGER_ENTRY_SIDES,
  Money,
  PERMISSIONS,
  type LedgerEntryType,
  type LedgerPartyType,
  type ListPartyLedgerQuery,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import {
  InternalError,
  NotFoundError,
  PermissionDeniedError,
  SelfApprovalError,
  ValidationError,
} from '../../common/errors/domain.error';
import { AuditService } from '../../infrastructure/database/audit.service';
import type { PrismaTransaction } from '../../infrastructure/database/prisma.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { SettingsService } from '../settings/settings.service';

/**
 * The party ledger — the source of truth for what is owed. See ADR-0015.
 *
 * ── The ledger is written in exactly ONE place ─────────────────────────────
 * `post()`, and only from inside the transaction of the document that causes
 * the entry. Same discipline as `StockLedgerService.move()` (ADR-0002): if a
 * future service writes `ledger_entry` directly, the sign convention and the
 * one-side rule become things people remember rather than things the system
 * enforces.
 *
 * There is no `update` and no `delete`. A database trigger rejects both
 * regardless, so a mistake is corrected by `contra()` — a new opposing row that
 * leaves the wrong one visible.
 *
 * ── There is no balance table ──────────────────────────────────────────────
 * ADR-0015 §4: a balance is `SUM(debit) − SUM(credit)`. Unlike stock, a party
 * balance is not read on a hot path and does not need a lock; a materialised
 * copy would only create a second thing that can disagree with the documents.
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(LedgerService.name);
  }

  /**
   * Appends one entry.
   *
   * MUST be called with the caller's transaction. Posting outside it would
   * allow a document to exist without its ledger effect, which is the window
   * ADR-0015 §5 exists to close.
   *
   * Exactly one of `debit` / `credit` may be supplied, and the side is checked
   * against `LEDGER_ENTRY_SIDES` — an `INVOICE` that credits, or a `PAYMENT`
   * that debits, is a sign error, and a sign error in a ledger is the kind of
   * bug that is found six months later by a partner rather than by a test.
   */
  async post(tx: PrismaTransaction, entry: LedgerPost): Promise<{ id: string }> {
    const debit = Money.of(entry.debit ?? '0');
    const credit = Money.of(entry.credit ?? '0');

    if (debit.isZero() === credit.isZero()) {
      throw new InternalError(
        'A ledger entry carries exactly one of debit or credit, and this one carries ' +
          (debit.isZero() ? 'neither' : 'both'),
        { entryType: entry.entryType, refType: entry.refType, refId: entry.refId },
      );
    }
    if (debit.isNegative() || credit.isNegative()) {
      throw new InternalError(
        'A ledger amount is never negative — post to the other side instead',
        { entryType: entry.entryType, debit: debit.toString(), credit: credit.toString() },
      );
    }

    const expected = LEDGER_ENTRY_SIDES[entry.entryType];
    const actual = debit.isPositive() ? 'DEBIT' : 'CREDIT';
    if (expected !== 'EITHER' && expected !== actual) {
      throw new InternalError(
        `A ${entry.entryType} entry posts a ${expected}, not a ${actual}. ` +
          'DEBIT increases what the party owes Hixaa (ADR-0015 §3).',
        { entryType: entry.entryType, refType: entry.refType, refId: entry.refId },
      );
    }

    if (!entry.partyId) {
      throw new InternalError('A ledger entry must name a party', {
        entryType: entry.entryType,
      });
    }

    const created = await tx.ledgerEntry.create({
      data: {
        // The API speaks partyType/partyId; the table holds two nullable FKs so
        // the scope extension has a relation to nest through (migration 0012).
        distributorId: entry.partyType === 'DISTRIBUTOR' ? entry.partyId : null,
        customerId: entry.partyType === 'CUSTOMER' ? entry.partyId : null,
        entryType: entry.entryType,
        debit: debit.toString(),
        credit: credit.toString(),
        refType: entry.refType ?? null,
        refId: entry.refId ?? null,
        refNumber: entry.refNumber ?? null,
        reversesId: entry.reversesId ?? null,
        entryDate: entry.entryDate ?? this.clock.now(),
        narration: entry.narration,
        createdById: entry.actorId ?? null,
      },
      select: { id: true },
    });

    return created;
  }

  /**
   * Reverses an entry by posting its mirror.
   *
   * The original stays. That is the whole point of an append-only ledger: a
   * bounced cheque, a mis-keyed amount and a disputed adjustment all leave a
   * trail rather than a hole, and "why did this balance change" is always
   * answerable.
   */
  async contra(
    tx: PrismaTransaction,
    entryId: string,
    narration: string,
    actorId?: string,
  ): Promise<{ id: string }> {
    const original = await tx.ledgerEntry.findFirst({
      where: { id: entryId },
      select: {
        id: true,
        distributorId: true,
        customerId: true,
        entryType: true,
        debit: true,
        credit: true,
        refType: true,
        refId: true,
        refNumber: true,
      },
    });
    if (!original) throw new NotFoundError('LedgerEntry', entryId);

    const debit = Money.of(original.debit.toFixed(4));
    const credit = Money.of(original.credit.toFixed(4));

    // ADJUSTMENT rather than the original type: the entry type says what CAUSED
    // the row, and what caused this one is a reversal, not a second invoice.
    // Posting it as `INVOICE` on the credit side would also trip the side check
    // above, which is the check doing its job.
    return this.post(tx, {
      partyType: original.distributorId ? 'DISTRIBUTOR' : 'CUSTOMER',
      partyId: original.distributorId ?? original.customerId ?? '',
      entryType: 'ADJUSTMENT',
      ...(debit.isPositive() ? { credit: debit.toString() } : { debit: credit.toString() }),
      refType: original.refType,
      refId: original.refId,
      refNumber: original.refNumber,
      reversesId: original.id,
      entryDate: this.clock.now(),
      narration,
      actorId,
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * The balance a party owes, as of a date.
   *
   * `SUM(debit) − SUM(credit)`. Positive means receivable.
   */
  async balanceFor(
    partyType: LedgerPartyType,
    partyId: string,
    asOf?: Date,
  ): Promise<Money> {
    const result = await this.prisma.db.ledgerEntry.aggregate({
      where: {
        ...partyWhere(partyType, partyId),
        ...(asOf ? { entryDate: { lte: asOf } } : {}),
      },
      _sum: { debit: true, credit: true },
    });

    return Money.of(result._sum.debit?.toFixed(4) ?? '0').subtract(
      result._sum.credit?.toFixed(4) ?? '0',
    );
  }

  /**
   * A statement of account with a running balance.
   *
   * The running balance is accumulated over the WHOLE ledger up to each row,
   * not over the page. A running balance that restarts at each page is worse
   * than none — it looks authoritative and is wrong, and a statement is exactly
   * the document a partner argues with.
   *
   * That is also why `openingBalance` is computed separately: a statement for
   * April must still reconcile without March in front of you.
   */
  async statement(
    partyType: LedgerPartyType,
    partyId: string,
    query: ListPartyLedgerQuery,
  ) {
    const party = await this.loadParty(partyType, partyId);

    const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : null;
    const to = query.to ? new Date(`${query.to}T00:00:00.000Z`) : null;

    const openingBalance = from
      ? await this.balanceBefore(partyType, partyId, from)
      : Money.zero();

    const where: Prisma.LedgerEntryWhereInput = {
      ...partyWhere(partyType, partyId),
      ...(query.entryType ? { entryType: query.entryType } : {}),
      ...(from || to
        ? { entryDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    };

    const entries = await this.prisma.db.ledgerEntry.findMany({
      where,
      orderBy: [{ entryDate: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        entryType: true,
        entryDate: true,
        narration: true,
        debit: true,
        credit: true,
        refType: true,
        refId: true,
        refNumber: true,
        reversesId: true,
        createdAt: true,
      },
    });

    let running = openingBalance;
    let totalDebits = Money.zero();
    let totalCredits = Money.zero();

    const rows = entries.map((entry) => {
      const debit = Money.of(entry.debit.toFixed(4));
      const credit = Money.of(entry.credit.toFixed(4));
      running = running.add(debit).subtract(credit);
      totalDebits = totalDebits.add(debit);
      totalCredits = totalCredits.add(credit);

      return {
        id: entry.id,
        entryType: entry.entryType,
        entryDate: entry.entryDate.toISOString().slice(0, 10),
        narration: entry.narration,
        debit: debit.toString(),
        credit: credit.toString(),
        runningBalance: running.toString(),
        refType: entry.refType,
        refId: entry.refId,
        refNumber: entry.refNumber,
        reversesId: entry.reversesId,
        createdAt: entry.createdAt,
      };
    });

    const creditLimit = party.creditLimit;
    const closingBalance = running;

    return {
      statement: {
        partyType,
        partyId,
        partyName: party.name,
        partyCode: party.code,
        partyGstin: party.gstin,
        openingBalance: openingBalance.toString(),
        totalDebits: totalDebits.toString(),
        totalCredits: totalCredits.toString(),
        closingBalance: closingBalance.toString(),
        creditLimit: creditLimit?.toString() ?? null,
        availableCredit: creditLimit ? creditLimit.subtract(closingBalance).toString() : null,
        from: query.from ?? null,
        to: query.to ?? null,
        entryCount: rows.length,
      },
      entries: rows,
    };
  }

  // ── Explicit acts with no document of their own ───────────────────────────

  /**
   * Writes off a balance the company will not collect.
   *
   * A ledger act rather than a payment: no money arrived, and recording it as a
   * receipt would overstate cash and understate bad debt. The reason is
   * mandatory and audited.
   */
  async writeOff(input: {
    partyType: LedgerPartyType;
    partyId: string;
    amount: string;
    reason: string;
    entryDate?: string;
    actorId: string;
    /**
     * A second person's id, required above the approval threshold.
     *
     * Phase 8 left this control undone and named it as an obligation on
     * Phase 9 (docs/24 §8). It is the same shape as order approval and payment
     * verification: writing off money the company will not collect is exactly
     * the act that should not be one person's decision.
     */
    approvedById?: string;
  }) {
    const amount = Money.of(input.amount);
    const balance = await this.balanceFor(input.partyType, input.partyId);

    if (amount.gt(balance)) {
      throw new ValidationError(
        `Cannot write off ${amount.format()} — the party owes ${balance.format()}. ` +
          'Writing off more than is owed would create a credit balance from nothing.',
      );
    }

    await this.assertWriteOffApproved(amount, input.actorId, input.approvedById);

    const entryDate = input.entryDate
      ? new Date(`${input.entryDate}T00:00:00.000Z`)
      : this.clock.now();

    const posted = await this.prisma.transaction(async (tx) => {
      const entry = await this.post(tx, {
        partyType: input.partyType,
        partyId: input.partyId,
        entryType: 'WRITE_OFF',
        credit: amount.toString(),
        entryDate,
        narration:
          `Write-off — ${input.reason}` +
          (input.approvedById ? ' (approved by a second authoriser)' : ''),
        actorId: input.actorId,
      });

      await this.audit.record(tx, {
        action: 'ledger.written-off',
        entityType: 'LedgerEntry',
        entityId: entry.id,
        after: {
          partyType: input.partyType,
          partyId: input.partyId,
          amount: amount.toString(),
          reason: input.reason,
          approvedById: input.approvedById ?? null,
        },
        metadata: { actorId: input.actorId, approvedById: input.approvedById ?? null },
      });

      return entry;
    });

    this.logger.warn(
      {
        partyType: input.partyType,
        partyId: input.partyId,
        amount: amount.toString(),
        reason: input.reason,
        actorId: input.actorId,
      },
      'BALANCE WRITTEN OFF',
    );

    return this.balanceFor(input.partyType, input.partyId).then((b) => ({
      entryId: posted.id,
      newBalance: b.toString(),
    }));
  }

  /**
   * The write-off approval gate — the second obligation Phase 8 left to Phase 9.
   *
   * Below the threshold a write-off is routine housekeeping (a few rupees of
   * rounding on a settled account) and requiring two people would only teach
   * everyone to share a login. Above it, the act needs a second authoriser who
   * is NOT the requester — the same separation as order approval and payment
   * verification, and refused with the same error class so the three read
   * identically in a log.
   *
   * The threshold is a SETTING, because "how much may one person forgive" is a
   * commercial policy that will change, and a constant would make changing it a
   * deploy.
   */
  private async assertWriteOffApproved(
    amount: Money,
    actorId: string,
    approvedById?: string,
  ): Promise<void> {
    const threshold = await this.writeOffThreshold();
    if (amount.lte(threshold)) return;

    if (!approvedById) {
      throw new ValidationError(
        `A write-off of ${amount.format()} exceeds the ${threshold.format()} threshold and ` +
          'requires a second authoriser. Money the company will not collect should not be one ' +
          'person’s decision.',
      );
    }

    if (approvedById === actorId) {
      throw new SelfApprovalError('write-off', 'authorise', 'requested');
    }

    // The approver must actually hold the authority, or "approved by" is a name
    // in a field rather than a control.
    const approver = await this.prisma.db.userRole.findFirst({
      where: {
        userId: approvedById,
        role: { permissions: { some: { permission: { key: PERMISSIONS.PAYMENT_DELETE } } } },
      },
      select: { userId: true },
    });
    if (!approver) {
      throw new PermissionDeniedError(PERMISSIONS.PAYMENT_DELETE);
    }
  }

  /** `finance.writeOffApprovalThreshold`, defaulting to ₹10,000. */
  private async writeOffThreshold(): Promise<Money> {
    const finance = await this.settings.get<{ writeOffApprovalThreshold?: string | number }>(
      'finance',
      'defaults',
    );
    const configured = finance?.writeOffApprovalThreshold;
    return Money.of(configured === undefined || configured === null ? '10000' : String(configured));
  }

  /**
   * A manual adjustment, or an opening balance carried in from a prior system.
   *
   * `amount` is SIGNED here, unusually: an adjustment is the one entry type
   * whose direction is genuinely the operator's decision rather than implied by
   * a document. Positive debits (they owe more), negative credits.
   */
  async adjust(input: {
    partyType: LedgerPartyType;
    partyId: string;
    amount: string;
    narration: string;
    entryDate?: string;
    isOpeningBalance: boolean;
    actorId: string;
  }) {
    const amount = Money.of(input.amount);
    const entryDate = input.entryDate
      ? new Date(`${input.entryDate}T00:00:00.000Z`)
      : this.clock.now();

    await this.loadParty(input.partyType, input.partyId);

    const posted = await this.prisma.transaction(async (tx) => {
      if (input.isOpeningBalance) {
        // Exactly one opening balance per party. A second would double the
        // carried-in figure, and the error is invisible in the total.
        const existing = await tx.ledgerEntry.count({
          where: {
            ...partyWhere(input.partyType, input.partyId),
            entryType: 'OPENING_BALANCE',
          },
        });
        if (existing > 0) {
          throw new ValidationError(
            'This party already has an opening balance. Post a correcting ADJUSTMENT instead — ' +
              'a second opening balance would silently double the carried-in figure.',
          );
        }
      }

      const entry = await this.post(tx, {
        partyType: input.partyType,
        partyId: input.partyId,
        entryType: input.isOpeningBalance ? 'OPENING_BALANCE' : 'ADJUSTMENT',
        ...(amount.isPositive()
          ? { debit: amount.toString() }
          : { credit: amount.abs().toString() }),
        entryDate,
        narration: input.narration,
        actorId: input.actorId,
      });

      await this.audit.record(tx, {
        action: input.isOpeningBalance ? 'ledger.opening-balance' : 'ledger.adjusted',
        entityType: 'LedgerEntry',
        entityId: entry.id,
        after: {
          partyType: input.partyType,
          partyId: input.partyId,
          amount: amount.toString(),
          narration: input.narration,
        },
        metadata: { actorId: input.actorId },
      });

      return entry;
    });

    const balance = await this.balanceFor(input.partyType, input.partyId);
    return { entryId: posted.id, newBalance: balance.toString() };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async balanceBefore(
    partyType: LedgerPartyType,
    partyId: string,
    before: Date,
  ): Promise<Money> {
    const result = await this.prisma.db.ledgerEntry.aggregate({
      where: { ...partyWhere(partyType, partyId), entryDate: { lt: before } },
      _sum: { debit: true, credit: true },
    });
    return Money.of(result._sum.debit?.toFixed(4) ?? '0').subtract(
      result._sum.credit?.toFixed(4) ?? '0',
    );
  }

  /**
   * Loads the party through `prisma.db`, so the SCOPE EXTENSION applies.
   *
   * That is what stops a territory-scoped user pulling a statement for a
   * distributor outside their subtree: the lookup 404s before any ledger row is
   * read. The ledger rows themselves are scoped too, but this refuses earlier
   * and with a better error.
   */
  private async loadParty(
    partyType: LedgerPartyType,
    partyId: string,
  ): Promise<{ name: string; code: string | null; gstin: string | null; creditLimit: Money | null }> {
    if (partyType === 'DISTRIBUTOR') {
      const distributor = await this.prisma.db.distributor.findFirst({
        where: { id: partyId },
        select: { legalName: true, code: true, gstin: true, creditLimit: true },
      });
      if (!distributor) throw new NotFoundError('Distributor', partyId);
      return {
        name: distributor.legalName,
        code: distributor.code,
        gstin: distributor.gstin,
        creditLimit: Money.of(distributor.creditLimit.toFixed(4)),
      };
    }

    const customer = await this.prisma.db.customer.findFirst({
      where: { id: partyId },
      select: { name: true, code: true, gstin: true },
    });
    if (!customer) throw new NotFoundError('Customer', partyId);
    // A Customer has no credit limit of its own — credit is extended to the
    // channel partner, not to the end customer.
    return { name: customer.name, code: customer.code, gstin: customer.gstin, creditLimit: null };
  }
}

/**
 * Translates the API's partyType/partyId pair into the table's two FK columns.
 *
 * One place, so a query cannot half-translate — matching on `distributorId`
 * while forgetting that a CUSTOMER entry leaves it null would silently return
 * nothing, which reads exactly like "this party has no ledger yet".
 */
const partyWhere = (
  partyType: LedgerPartyType,
  partyId: string,
): Prisma.LedgerEntryWhereInput =>
  partyType === 'DISTRIBUTOR' ? { distributorId: partyId } : { customerId: partyId };

export interface LedgerPost {
  partyType: LedgerPartyType;
  partyId: string;
  entryType: LedgerEntryType;
  debit?: string;
  credit?: string;
  refType?: string | null;
  refId?: string | null;
  refNumber?: string | null;
  reversesId?: string | null;
  entryDate?: Date;
  narration: string;
  actorId?: string;
}
