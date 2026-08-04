import { Injectable } from '@nestjs/common';
import {
  DOMAIN_EVENTS,
  Money,
  type AllocatePaymentDto,
  type CreatePaymentDto,
  type ListPaymentsQuery,
  type UpdatePaymentDto,
  type VerifyPaymentDto,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import {
  ConflictError,
  ImmutableRecordError,
  NotFoundError,
  SelfApprovalError,
  ValidationError,
} from '../../common/errors/domain.error';
import { keysetWhere, toListResult } from '../../common/utils/pagination.util';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { NumberSequenceService } from '../distributors/number-sequence.service';
import { InvoicesService } from './invoices.service';
import { LedgerService } from './ledger.service';

/**
 * Payments — recording, verification, and allocation. See ADR-0018.
 *
 * ── The one thing to understand before changing anything here ──────────────
 * RECORDING A PAYMENT HAS NO FINANCIAL EFFECT. It writes a memo. Verification
 * is what credits the ledger, and only a verified payment can be allocated.
 *
 * That is not ceremony. `OrderApprovalService.checkCredit` now sums
 * `invoice.amountOutstanding`, so allowing allocation at `RECORDED` would let
 * an unconfirmed claim reduce a real receivable AND free up real credit — an
 * unverified payment would buy a real order. Moving the ledger write earlier
 * "for convenience" reopens exactly that hole.
 *
 * ── Over-allocation is a genuine race ──────────────────────────────────────
 * Two concurrent allocations against one payment is the same shape as the
 * oversell race `StockLedgerService.move()` was built to close: check-then-write
 * loses it. `allocate()` takes `SELECT … FOR UPDATE` on the payment row BEFORE
 * reading `unallocatedAmount`. The Zod refinement and the CHECK constraint make
 * the failure fast and the invariant legible; the lock is the control.
 */
const PAYMENT_SELECT = {
  id: true,
  number: true,
  status: true,
  method: true,
  distributorId: true,
  customerId: true,
  amount: true,
  tdsAmount: true,
  unallocatedAmount: true,
  paymentDate: true,
  referenceNumber: true,
  bankName: true,
  chequeNumber: true,
  chequeDate: true,
  recordedById: true,
  verifiedById: true,
  verifiedAt: true,
  bouncedAt: true,
  bouncedReason: true,
  notes: true,
  createdAt: true,
  distributor: { select: { legalName: true } },
  customer: { select: { name: true } },
  allocations: { select: { id: true } },
} satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly ledger: LedgerService,
    private readonly sequences: NumberSequenceService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PaymentsService.name);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async list(query: ListPaymentsQuery) {
    const status = Array.isArray(query.status) ? query.status : query.status ? [query.status] : [];

    const where: Prisma.PaymentWhereInput = {
      ...(status.length ? { status: { in: status } } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.distributorId ? { distributorId: query.distributorId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.unallocatedOnly ? { status: 'VERIFIED', unallocatedAmount: { gt: 0 } } : {}),
      ...(query.awaitingVerification ? { status: 'RECORDED' } : {}),
      ...(query.from || query.to
        ? {
            paymentDate: {
              ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
              ...(query.to ? { lte: new Date(`${query.to}T00:00:00.000Z`) } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { number: { contains: query.q, mode: 'insensitive' } },
              { referenceNumber: { contains: query.q, mode: 'insensitive' } },
              { chequeNumber: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const cursorWhere = keysetWhere(query.cursor);
    const rows = await this.prisma.db.payment.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: PAYMENT_SELECT,
    });

    const totalCount = query.includeTotal
      ? await this.prisma.db.payment.count({ where })
      : undefined;

    const result = toListResult(rows, query.limit, totalCount);
    return { ...result, data: result.data.map((row) => toSummary(row)) };
  }

  async findDetail(id: string) {
    const payment = await this.prisma.db.payment.findFirst({
      where: { id },
      select: PAYMENT_SELECT,
    });
    if (!payment) throw new NotFoundError('Payment', id);

    const allocations = await this.prisma.db.paymentAllocation.findMany({
      where: { paymentId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        amount: true,
        tdsPortion: true,
        notes: true,
        createdAt: true,
        invoice: {
          select: {
            id: true,
            number: true,
            invoiceDate: true,
            grandTotal: true,
            amountOutstanding: true,
          },
        },
      },
    });

    const [recorder, verifier] = await Promise.all([
      this.userName(payment.recordedById),
      payment.verifiedById ? this.userName(payment.verifiedById) : Promise.resolve(null),
    ]);

    return {
      ...toSummary(payment, { recordedByName: recorder, verifiedByName: verifier }),
      allocations: allocations.map((allocation) => ({
        id: allocation.id,
        invoiceId: allocation.invoice.id,
        invoiceNumber: allocation.invoice.number,
        invoiceDate: allocation.invoice.invoiceDate.toISOString().slice(0, 10),
        invoiceGrandTotal: allocation.invoice.grandTotal.toFixed(4),
        invoiceOutstanding: allocation.invoice.amountOutstanding.toFixed(4),
        amount: allocation.amount.toFixed(4),
        tdsPortion: allocation.tdsPortion.toFixed(4),
        notes: allocation.notes,
        createdAt: allocation.createdAt,
      })),
    };
  }

  // ── 1. Record — a memo, with no financial effect ──────────────────────────

  async create(dto: CreatePaymentDto, actorId: string) {
    await this.assertPartyVisible(dto.distributorId, dto.customerId);

    const amount = Money.of(dto.amount);
    const tds = Money.of(dto.tdsAmount ?? '0');
    const total = amount.add(tds);
    const paymentDate = dto.paymentDate
      ? new Date(`${dto.paymentDate}T00:00:00.000Z`)
      : this.clock.now();

    const created = await this.prisma.transaction(async (tx) => {
      const number = await this.sequences.next(tx, 'PAYMENT');

      const payment = await tx.payment.create({
        data: {
          number,
          status: 'RECORDED',
          distributorId: dto.distributorId ?? null,
          customerId: dto.customerId ?? null,
          method: dto.method,
          amount: amount.toString(),
          tdsAmount: tds.toString(),
          // Nothing is allocated yet, and nothing can be until verification.
          unallocatedAmount: total.toString(),
          paymentDate,
          referenceNumber: dto.referenceNumber ?? null,
          bankName: dto.bankName ?? null,
          chequeNumber: dto.chequeNumber ?? null,
          chequeDate: dto.chequeDate ? new Date(`${dto.chequeDate}T00:00:00.000Z`) : null,
          notes: dto.notes ?? null,
          recordedById: actorId,
        },
        select: PAYMENT_SELECT,
      });

      await this.audit.record(tx, {
        action: 'payment.recorded',
        entityType: 'Payment',
        entityId: payment.id,
        after: {
          number,
          amount: amount.toString(),
          tdsAmount: tds.toString(),
          method: dto.method,
          // Stated in the audit trail because it is the thing people get wrong
          // about this record when they read it later.
          ledgerEffect: 'none until verified',
        },
        metadata: { actorId },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.PAYMENT_RECORDED,
        { type: 'Payment', id: payment.id },
        { number, amount: amount.toString(), method: dto.method },
      );

      return payment;
    });

    // Requested allocations are deliberately NOT applied here — they are held
    // until verification. Saying so out loud, because silently ignoring part of
    // a request is worse than refusing it.
    if (dto.allocations?.length) {
      this.logger.info(
        { paymentId: created.id, requested: dto.allocations.length },
        'Allocations supplied at recording will be applied when the payment is verified',
      );
    }

    return toSummary(created);
  }

  /** Editable only while RECORDED — after verification the ledger is posted. */
  async update(id: string, dto: UpdatePaymentDto, actorId: string) {
    const payment = await this.load(id);
    if (payment.status !== 'RECORDED') {
      throw new ImmutableRecordError(
        'payment',
        `${payment.number} is ${payment.status}: the ledger has already been credited, and the ` +
          'ledger is append-only. Mark it BOUNCED and record a corrected receipt instead.',
      );
    }

    const amount = Money.of(dto.amount ?? payment.amount.toFixed(4));
    const tds = Money.of(dto.tdsAmount ?? payment.tdsAmount.toFixed(4));

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.payment.update({
        where: { id },
        data: {
          ...(dto.method ? { method: dto.method } : {}),
          ...(dto.amount !== undefined ? { amount: amount.toString() } : {}),
          ...(dto.tdsAmount !== undefined ? { tdsAmount: tds.toString() } : {}),
          // Nothing is allocated while RECORDED, so the whole value is free.
          unallocatedAmount: amount.add(tds).toString(),
          ...(dto.paymentDate
            ? { paymentDate: new Date(`${dto.paymentDate}T00:00:00.000Z`) }
            : {}),
          ...(dto.referenceNumber !== undefined ? { referenceNumber: dto.referenceNumber } : {}),
          ...(dto.bankName !== undefined ? { bankName: dto.bankName } : {}),
          ...(dto.chequeNumber !== undefined ? { chequeNumber: dto.chequeNumber } : {}),
          ...(dto.chequeDate
            ? { chequeDate: new Date(`${dto.chequeDate}T00:00:00.000Z`) }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
        select: PAYMENT_SELECT,
      });

      await this.audit.record(tx, {
        action: 'payment.updated',
        entityType: 'Payment',
        entityId: id,
        before: { amount: payment.amount.toFixed(4), tdsAmount: payment.tdsAmount.toFixed(4) },
        after: { amount: amount.toString(), tdsAmount: tds.toString() },
        metadata: { actorId },
      });

      return result;
    });

    return toSummary(updated);
  }

  // ── 2. Verify — the financial event ───────────────────────────────────────

  /**
   * Confirms a receipt and credits the ledger.
   *
   * Two independent refusals guard this:
   *   • `SEGREGATION_OF_DUTIES` stops one ROLE holding both permissions. That is
   *     enforced when a role is created, not here.
   *   • The self-verification check below stops one PERSON doing both, which the
   *     role rule cannot — holding two roles is normal in a company this size.
   *
   * The database also carries a CHECK on the same condition. Three layers,
   * because a financial control that depends on any single one of them being
   * remembered is not a control.
   */
  async verify(id: string, dto: VerifyPaymentDto, actorId: string) {
    const payment = await this.load(id);

    if (payment.status !== 'RECORDED') {
      throw new ConflictError(
        `Payment ${payment.number} is ${payment.status} and cannot be verified again. ` +
          'Verification credits the ledger exactly once.',
      );
    }

    if (payment.recordedById === actorId) {
      throw new SelfApprovalError('payment', 'verify', 'recorded');
    }

    const amount = Money.of(payment.amount.toFixed(4));
    const tds = Money.of(payment.tdsAmount.toFixed(4));
    const verifiedAt = this.clock.now();
    const partyType = payment.distributorId ? 'DISTRIBUTOR' : 'CUSTOMER';
    const partyId = payment.distributorId ?? payment.customerId ?? '';

    const verified = await this.prisma.transaction(async (tx) => {
      const result = await tx.payment.update({
        where: { id },
        data: { status: 'VERIFIED', verifiedById: actorId, verifiedAt },
        select: PAYMENT_SELECT,
      });

      // Cash and TDS are SEPARATE credits. A customer settling ₹1,00,000 with
      // ₹98,000 after deducting ₹2,000 has paid in full, but the ₹2,000 is
      // recoverable from the government and the ₹98,000 is in the bank — they
      // reconcile against different statements (ADR-0018 §4).
      await this.ledger.post(tx, {
        partyType,
        partyId,
        entryType: 'PAYMENT',
        credit: amount.toString(),
        refType: 'Payment',
        refId: id,
        refNumber: payment.number,
        entryDate: payment.paymentDate,
        narration:
          `Receipt ${payment.number} — ${payment.method}` +
          (payment.referenceNumber ? ` ref ${payment.referenceNumber}` : ''),
        actorId,
      });

      if (tds.isPositive()) {
        await this.ledger.post(tx, {
          partyType,
          partyId,
          entryType: 'TDS',
          credit: tds.toString(),
          refType: 'Payment',
          refId: id,
          refNumber: payment.number,
          entryDate: payment.paymentDate,
          narration: `TDS deducted against receipt ${payment.number}`,
          actorId,
        });
      }

      await this.audit.record(tx, {
        action: 'payment.verified',
        entityType: 'Payment',
        entityId: id,
        after: {
          number: payment.number,
          amount: amount.toString(),
          tdsAmount: tds.toString(),
          verificationNote: dto.verificationNote ?? null,
        },
        metadata: { actorId, recordedById: payment.recordedById },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.PAYMENT_VERIFIED,
        { type: 'Payment', id },
        { number: payment.number, amount: amount.toString() },
      );

      return result;
    });

    this.logger.info(
      { paymentId: id, number: payment.number, verifiedBy: actorId },
      'Payment verified — ledger credited',
    );

    if (dto.allocations?.length) {
      return this.allocate(id, { allocations: dto.allocations }, actorId);
    }

    return toSummary(verified);
  }

  // ── 3. Allocate — apply a verified receipt to invoices ────────────────────

  /**
   * Applies a payment across invoices, under a row lock.
   *
   * The lock is the control. Everything else — the Zod refinement, the CHECK
   * constraint — makes the failure fast and the invariant readable, but two
   * concurrent requests each reading `unallocatedAmount` before either writes
   * is a real race, and only `FOR UPDATE` closes it. Same shape, same fix, as
   * HANDOFF §4.15.
   */
  async allocate(id: string, dto: AllocatePaymentDto, actorId: string) {
    const payment = await this.load(id);

    if (payment.status !== 'VERIFIED') {
      throw new ConflictError(
        `Payment ${payment.number} is ${payment.status}. Only a VERIFIED receipt can be ` +
          'allocated — an unconfirmed payment must not reduce a receivable or free up credit ' +
          '(ADR-0018 §3).',
      );
    }

    const requested = Money.sum(dto.allocations.map((a) => a.amount));

    const result = await this.prisma.transaction(async (tx) => {
      // FOR UPDATE before reading the figure we are about to spend. Held until
      // this transaction commits, so a concurrent allocation serialises here
      // rather than reading a stale unallocated amount.
      const locked = await tx.$queryRaw<Array<{ unallocated_amount: string }>>`
        SELECT unallocated_amount
        FROM payment
        WHERE id = ${id}::uuid
        FOR UPDATE
      `;
      const available = Money.of(locked[0]?.unallocated_amount ?? '0');

      if (requested.gt(available)) {
        throw new ValidationError(
          `Cannot allocate ${requested.format()} — only ${available.format()} of receipt ` +
            `${payment.number} is unapplied.`,
        );
      }

      const touched: string[] = [];

      for (const allocation of dto.allocations) {
        const invoice = await tx.invoice.findFirst({
          where: { id: allocation.invoiceId },
          select: {
            id: true,
            number: true,
            status: true,
            distributorId: true,
            customerId: true,
            amountOutstanding: true,
          },
        });
        if (!invoice) throw new NotFoundError('Invoice', allocation.invoiceId);

        if (invoice.status === 'DRAFT') {
          throw new ConflictError(
            'Cannot allocate against a draft invoice — it has not been issued and owes nothing.',
          );
        }
        if (invoice.status === 'CANCELLED') {
          throw new ConflictError(
            `Invoice ${invoice.number} is cancelled and cannot take a payment.`,
          );
        }

        // The receipt and the invoice must belong to the same party, or a
        // payment from one partner would settle another's debt.
        const sameParty =
          invoice.distributorId === payment.distributorId &&
          invoice.customerId === payment.customerId;
        if (!sameParty) {
          throw new ValidationError(
            `Invoice ${invoice.number} belongs to a different party than receipt ` +
              `${payment.number}. A payment settles its own payer's invoices.`,
          );
        }

        const amount = Money.of(allocation.amount);
        const outstanding = Money.of(invoice.amountOutstanding.toFixed(4));
        if (amount.gt(outstanding)) {
          throw new ValidationError(
            `Cannot allocate ${amount.format()} to invoice ${invoice.number} — only ` +
              `${outstanding.format()} is outstanding. Over-settling would create a credit ` +
              'balance the invoice cannot express.',
          );
        }

        // The TDS share of this allocation, proportional to how much of the
        // whole receipt it represents. Proportional rather than "TDS first" so
        // a part-allocated receipt does not report all its TDS against the
        // first invoice it touches.
        const totalValue = Money.of(payment.amount.toFixed(4)).add(
          payment.tdsAmount.toFixed(4),
        );
        const tdsPortion = totalValue.isZero()
          ? Money.zero()
          : Money.of(payment.tdsAmount.toFixed(4))
              .multiply(amount.toString())
              .divide(totalValue.toString())
              .round(4);

        // One allocation row per (payment, invoice) pair — a second application
        // of the same receipt to the same invoice ADDS to the existing row
        // rather than creating a duplicate the unique constraint would reject.
        // Read-then-write is safe here: the payment row is already locked, and
        // every allocation against it serialises behind that lock.
        const existing = await tx.paymentAllocation.findFirst({
          where: { paymentId: id, invoiceId: allocation.invoiceId },
          select: { id: true, amount: true, tdsPortion: true },
        });

        if (existing) {
          await tx.paymentAllocation.update({
            where: { id: existing.id },
            data: {
              amount: Money.of(existing.amount.toFixed(4)).add(amount).toString(),
              tdsPortion: Money.of(existing.tdsPortion.toFixed(4)).add(tdsPortion).toString(),
              ...(allocation.notes ? { notes: allocation.notes } : {}),
            },
          });
        } else {
          await tx.paymentAllocation.create({
            data: {
              paymentId: id,
              invoiceId: allocation.invoiceId,
              amount: amount.toString(),
              tdsPortion: tdsPortion.toString(),
              notes: allocation.notes ?? null,
              createdById: actorId,
            },
          });
        }

        await this.invoices.refreshSettlement(tx, allocation.invoiceId);
        touched.push(invoice.number ?? invoice.id);
      }

      const updated = await tx.payment.update({
        where: { id },
        data: { unallocatedAmount: available.subtract(requested).toString() },
        select: PAYMENT_SELECT,
      });

      await this.audit.record(tx, {
        action: 'payment.allocated',
        entityType: 'Payment',
        entityId: id,
        after: {
          number: payment.number,
          allocated: requested.toString(),
          invoices: touched,
          unallocatedAfter: available.subtract(requested).toString(),
        },
        metadata: { actorId },
      });

      return updated;
    });

    return toSummary(result);
  }

  /** Removes an allocation, returning the money to the receipt and the debt to the invoice. */
  async removeAllocation(paymentId: string, allocationId: string, actorId: string) {
    const payment = await this.load(paymentId);

    const updated = await this.prisma.transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ unallocated_amount: string }>>`
        SELECT unallocated_amount FROM payment WHERE id = ${paymentId}::uuid FOR UPDATE
      `;
      const available = Money.of(locked[0]?.unallocated_amount ?? '0');

      const allocation = await tx.paymentAllocation.findFirst({
        where: { id: allocationId, paymentId },
        select: { id: true, amount: true, invoiceId: true },
      });
      if (!allocation) throw new NotFoundError('PaymentAllocation', allocationId);

      await tx.paymentAllocation.delete({ where: { id: allocationId } });
      await this.invoices.refreshSettlement(tx, allocation.invoiceId);

      const result = await tx.payment.update({
        where: { id: paymentId },
        data: {
          unallocatedAmount: available.add(allocation.amount.toFixed(4)).toString(),
        },
        select: PAYMENT_SELECT,
      });

      await this.audit.record(tx, {
        action: 'payment.allocation-removed',
        entityType: 'Payment',
        entityId: paymentId,
        before: {
          allocationId,
          amount: allocation.amount.toFixed(4),
          invoiceId: allocation.invoiceId,
        },
        metadata: { actorId, number: payment.number },
      });

      return result;
    });

    return toSummary(updated);
  }

  // ── Bounce — contra, never delete ─────────────────────────────────────────

  /**
   * A cheque that did not clear.
   *
   * Contra-posts the ledger entries and reverses every allocation. The original
   * entries stay (ADR-0015 §1) — a bounced payment is a thing that happened,
   * and the partner's ledger should show it.
   */
  async bounce(id: string, reason: string, actorId: string) {
    const payment = await this.load(id);

    if (payment.status !== 'VERIFIED') {
      throw new ConflictError(
        `Payment ${payment.number} is ${payment.status}. Only a verified receipt can bounce — ` +
          'an unverified one has no effect to reverse and should be cancelled instead.',
      );
    }

    const bouncedAt = this.clock.now();

    const bounced = await this.prisma.transaction(async (tx) => {
      const entries = await tx.ledgerEntry.findMany({
        where: { refType: 'Payment', refId: id, reversesId: null },
        select: { id: true },
      });

      for (const entry of entries) {
        await this.ledger.contra(
          tx,
          entry.id,
          `Receipt ${payment.number} bounced — ${reason}`,
          actorId,
        );
      }

      const allocations = await tx.paymentAllocation.findMany({
        where: { paymentId: id },
        select: { id: true, invoiceId: true },
      });

      for (const allocation of allocations) {
        await tx.paymentAllocation.delete({ where: { id: allocation.id } });
        await this.invoices.refreshSettlement(tx, allocation.invoiceId);
      }

      const result = await tx.payment.update({
        where: { id },
        data: {
          status: 'BOUNCED',
          bouncedAt,
          bouncedReason: reason,
          unallocatedAmount: '0',
        },
        select: PAYMENT_SELECT,
      });

      await this.audit.record(tx, {
        action: 'payment.bounced',
        entityType: 'Payment',
        entityId: id,
        after: {
          number: payment.number,
          reason,
          reversedEntries: entries.length,
          reversedAllocations: allocations.length,
        },
        metadata: { actorId },
      });

      return result;
    });

    this.logger.warn(
      { paymentId: id, number: payment.number, reason },
      'PAYMENT BOUNCED — ledger entries contra-posted',
    );

    return toSummary(bounced);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Loads the party through `prisma.db` so the scope extension applies.
   *
   * Without this, a territory-scoped user could record a receipt against a
   * distributor outside their subtree — the payment row itself is scoped, but
   * only after it exists.
   */
  private async assertPartyVisible(
    distributorId?: string,
    customerId?: string,
  ): Promise<void> {
    if (distributorId) {
      const found = await this.prisma.db.distributor.findFirst({
        where: { id: distributorId },
        select: { id: true },
      });
      if (!found) throw new NotFoundError('Distributor', distributorId);
      return;
    }
    if (customerId) {
      const found = await this.prisma.db.customer.findFirst({
        where: { id: customerId },
        select: { id: true },
      });
      if (!found) throw new NotFoundError('Customer', customerId);
      return;
    }
    throw new ValidationError('A payment must name a distributor or a customer');
  }

  private async load(id: string) {
    const payment = await this.prisma.db.payment.findFirst({
      where: { id },
      select: {
        id: true,
        number: true,
        status: true,
        method: true,
        amount: true,
        tdsAmount: true,
        unallocatedAmount: true,
        paymentDate: true,
        referenceNumber: true,
        distributorId: true,
        customerId: true,
        recordedById: true,
      },
    });
    if (!payment) throw new NotFoundError('Payment', id);
    return payment;
  }

  private async userName(id: string): Promise<string | null> {
    const user = await this.prisma.db.user.findFirst({
      where: { id },
      select: { firstName: true, lastName: true, email: true },
    });
    if (!user) return null;
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
    return name || user.email;
  }
}

function toSummary(
  row: PaymentRow,
  names?: { recordedByName: string | null; verifiedByName: string | null },
) {
  const amount = Money.of(row.amount.toFixed(4));
  const tds = Money.of(row.tdsAmount.toFixed(4));

  return {
    id: row.id,
    number: row.number,
    status: row.status,
    method: row.method,
    distributorId: row.distributorId,
    distributorName: row.distributor?.legalName ?? null,
    customerId: row.customerId,
    customerName: row.customer?.name ?? null,
    amount: amount.toString(),
    tdsAmount: tds.toString(),
    totalValue: amount.add(tds).toString(),
    unallocatedAmount: row.unallocatedAmount.toFixed(4),
    paymentDate: row.paymentDate.toISOString().slice(0, 10),
    referenceNumber: row.referenceNumber,
    bankName: row.bankName,
    chequeNumber: row.chequeNumber,
    chequeDate: row.chequeDate ? row.chequeDate.toISOString().slice(0, 10) : null,
    recordedById: row.recordedById,
    recordedByName: names?.recordedByName ?? null,
    verifiedById: row.verifiedById,
    verifiedByName: names?.verifiedByName ?? null,
    verifiedAt: row.verifiedAt,
    // Surfaced explicitly so a list can show, at a glance, which receipts have
    // no financial effect yet.
    awaitingVerification: row.status === 'RECORDED',
    bouncedAt: row.bouncedAt,
    bouncedReason: row.bouncedReason,
    allocationCount: row.allocations.length,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}
