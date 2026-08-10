import { Injectable } from '@nestjs/common';
import {
  DOMAIN_EVENTS,
  REQUIRED_KYC_FOR_APPROVAL,
  canTransitionDistributor,
  maskTailValue,
  type CreateDistributorDto,
  type ListDistributorsQuery,
  type UpdateDistributorDto,
} from '@hixaa/contracts';
import type { AddressDto } from '@hixaa/contracts';
import type { DistributorStatus, Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import { keysetWhere, parseSort, toListResult } from '../../common/utils/pagination.util';
import {
  AlreadyExistsError,
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
} from '../../common/errors/domain.error';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService, type PrismaTransaction } from '../../infrastructure/database/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { EncryptionService } from '../auth/services/encryption.service';
import { NumberSequenceService } from './number-sequence.service';

const SORTABLE = ['createdAt', 'legalName', 'onboardedAt', 'creditLimit'] as const;

const DISTRIBUTOR_SELECT = {
  id: true,
  code: true,
  legalName: true,
  tradeName: true,
  type: true,
  status: true,
  gstin: true,
  pan: true,
  territoryId: true,
  accountManagerId: true,
  creditLimit: true,
  creditDays: true,
  bankAccountEncrypted: true,
  tags: true,
  onboardedAt: true,
  createdAt: true,
  territory: { select: { name: true } },
  accountManager: { select: { firstName: true, lastName: true } },
  documents: { select: { type: true, verifiedAt: true } },
  _count: { select: { contacts: true } },
} satisfies Prisma.DistributorSelect;

/**
 * The fields an edit form needs back, which the summary deliberately omits.
 *
 * Kept out of `DISTRIBUTOR_SELECT` because that projection also serves the
 * list: joining two addresses onto every row would be two joins per record on
 * a table 11.2 load-tested at 100k, to render columns the list never shows.
 *
 * `bankAccountEncrypted` is absent on purpose. An edit form does not need the
 * account number to leave it unchanged — `update()` treats `undefined` as "not
 * supplied" — so the plaintext never has to be decrypted, sent, or held in a
 * browser. The form shows the masked value and says blank means keep.
 */
const ADDRESS_SELECT = {
  label: true,
  line1: true,
  line2: true,
  landmark: true,
  cityId: true,
  cityName: true,
  stateId: true,
  postalCode: true,
  countryCode: true,
  contactName: true,
  contactPhone: true,
} satisfies Prisma.AddressSelect;

const DISTRIBUTOR_EDITABLE_SELECT = {
  tan: true,
  cin: true,
  msmeNumber: true,
  paymentTermsCode: true,
  website: true,
  bankAccountName: true,
  bankIfsc: true,
  bankName: true,
  billingAddress: { select: ADDRESS_SELECT },
  shippingAddress: { select: ADDRESS_SELECT },
} satisfies Prisma.DistributorSelect;

@Injectable()
export class DistributorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly sequences: NumberSequenceService,
    private readonly encryption: EncryptionService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DistributorsService.name);
  }

  async list(query: ListDistributorsQuery) {
    const where: Prisma.DistributorWhereInput = {
      ...(query.status?.length ? { status: { in: query.status } } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.territoryId ? { territoryId: query.territoryId } : {}),
      ...(query.accountManagerId ? { accountManagerId: query.accountManagerId } : {}),
      ...(query.q
        ? {
            OR: [
              { legalName: { contains: query.q, mode: 'insensitive' } },
              { tradeName: { contains: query.q, mode: 'insensitive' } },
              { code: { contains: query.q.toUpperCase() } },
              { gstin: { contains: query.q.toUpperCase() } },
            ],
          }
        : {}),
    };

    const cursorWhere = keysetWhere(query.cursor);

    // The scope extension adds the territory predicate automatically — a
    // territory-scoped caller never sees a distributor outside their subtree,
    // and this method does not need to know that.
    const rows = await this.prisma.db.distributor.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: parseSort(query.sort, SORTABLE),
      take: query.limit + 1,
      select: DISTRIBUTOR_SELECT,
    });

    const totalCount = query.includeTotal
      ? await this.prisma.db.distributor.count({ where })
      : undefined;

    const result = toListResult(rows, query.limit, totalCount);
    return { ...result, data: result.data.map((row) => this.toSummary(row)) };
  }

  async findById(id: string) {
    const distributor = await this.prisma.db.distributor.findFirst({
      where: { id },
      select: DISTRIBUTOR_SELECT,
    });
    if (!distributor) throw new NotFoundError('Distributor', id);
    return this.toSummary(distributor);
  }

  /** Profile plus contacts, KYC, notes, and agreements — the 360 view. */
  async findDetail(id: string) {
    const summary = await this.findById(id);

    const [editable, contacts, documents, notes, agreements] = await Promise.all([
      this.prisma.db.distributor.findFirst({
        where: { id },
        select: DISTRIBUTOR_EDITABLE_SELECT,
      }),
      this.prisma.db.distributorContact.findMany({
        where: { distributorId: id },
        orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          designation: true,
          email: true,
          phone: true,
          isPrimary: true,
          portalUserId: true,
        },
      }),
      this.prisma.db.distributorDocument.findMany({
        where: { distributorId: id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          type: true,
          expiresAt: true,
          verifiedAt: true,
          rejectedAt: true,
          rejectionReason: true,
          documentId: true,
          document: { select: { originalName: true, sizeBytes: true, mimeType: true } },
        },
      }),
      this.prisma.db.distributorNote.findMany({
        where: { distributorId: id },
        orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
        take: 50,
        select: {
          id: true,
          body: true,
          isPinned: true,
          createdAt: true,
          author: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.db.agreement.findMany({
        where: { distributorId: id },
        orderBy: { startDate: 'desc' },
        select: {
          id: true,
          reference: true,
          startDate: true,
          endDate: true,
          targetAmount: true,
          status: true,
        },
      }),
    ]);

    return {
      ...summary,
      // Everything the update DTO accepts, so an edit form can be pre-filled
      // with what is actually stored rather than showing blanks that read as
      // "nothing on file". Nested so it is obvious which half of this response
      // is for display and which is for editing.
      editable: {
        tan: editable?.tan ?? null,
        cin: editable?.cin ?? null,
        msmeNumber: editable?.msmeNumber ?? null,
        paymentTermsCode: editable?.paymentTermsCode ?? null,
        website: editable?.website ?? null,
        bankAccountName: editable?.bankAccountName ?? null,
        bankIfsc: editable?.bankIfsc ?? null,
        bankName: editable?.bankName ?? null,
        billingAddress: editable?.billingAddress ?? null,
        shippingAddress: editable?.shippingAddress ?? null,
      },
      contacts,
      documents: documents.map((doc) => ({
        ...doc,
        document: doc.document
          ? { ...doc.document, sizeBytes: Number(doc.document.sizeBytes) }
          : null,
      })),
      notes: notes.map((note) => ({
        id: note.id,
        body: note.body,
        isPinned: note.isPinned,
        createdAt: note.createdAt,
        authorName: note.author ? `${note.author.firstName} ${note.author.lastName}` : null,
      })),
      agreements,
      // Populated in Phases 7–8; declared now so the frontend shape is stable
      // and does not change when orders and invoices arrive.
      commercials: {
        outstanding: null as string | null,
        ordersLast12Months: null as number | null,
        note: 'Sales and outstanding arrive with orders (Phase 7) and invoicing (Phase 8).',
      },
    };
  }

  async create(dto: CreateDistributorDto, actorId: string) {
    if (dto.gstin) {
      const existing = await this.prisma.db.distributor.findFirst({
        where: { gstin: dto.gstin },
        select: { id: true, code: true },
      });
      if (existing) throw new AlreadyExistsError('distributor', 'gstin', dto.gstin);
    }

    const created = await this.prisma.transaction(async (tx) => {
      const code = await this.sequences.next(tx, 'DISTRIBUTOR');

      const billingAddressId = dto.billingAddress
        ? await this.createAddress(tx, dto.billingAddress)
        : null;
      const shippingAddressId = dto.shippingAddress
        ? await this.createAddress(tx, dto.shippingAddress)
        : null;

      const distributor = await tx.distributor.create({
        data: {
          code,
          legalName: dto.legalName,
          tradeName: dto.tradeName ?? null,
          type: dto.type,
          // Always starts as a LEAD. Creating something already ACTIVE would
          // bypass the KYC gate entirely.
          status: 'LEAD',
          territoryId: dto.territoryId ?? null,
          accountManagerId: dto.accountManagerId ?? null,
          gstin: dto.gstin ?? null,
          pan: dto.pan ?? null,
          tan: dto.tan ?? null,
          cin: dto.cin ?? null,
          msmeNumber: dto.msmeNumber ?? null,
          creditLimit: dto.creditLimit,
          creditDays: dto.creditDays,
          openingBalance: dto.openingBalance,
          paymentTermsCode: dto.paymentTermsCode ?? null,
          website: dto.website || null,
          tags: dto.tags,
          bankAccountName: dto.bankAccountName ?? null,
          // Encrypted at rest — a database leak must not hand over the channel's
          // banking details.
          bankAccountEncrypted: dto.bankAccountNumber
            ? this.encryption.encrypt(dto.bankAccountNumber)
            : null,
          bankIfsc: dto.bankIfsc ?? null,
          bankName: dto.bankName ?? null,
          billingAddressId,
          shippingAddressId,
          createdById: actorId,
        },
        select: DISTRIBUTOR_SELECT,
      });

      await this.audit.record(tx, {
        action: 'distributor.created',
        entityType: 'Distributor',
        entityId: distributor.id,
        after: { code, legalName: dto.legalName, gstin: dto.gstin ?? null, status: 'LEAD' },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.DISTRIBUTOR_CREATED,
        { type: 'Distributor', id: distributor.id },
        { code, legalName: dto.legalName },
      );

      return distributor;
    });

    this.logger.info({ distributorId: created.id, code: created.code }, 'Distributor created');
    return this.toSummary(created);
  }

  async update(id: string, dto: UpdateDistributorDto, actorId: string) {
    const before = await this.prisma.db.distributor.findFirst({
      where: { id },
      select: {
        id: true,
        legalName: true,
        tradeName: true,
        type: true,
        territoryId: true,
        accountManagerId: true,
        gstin: true,
        pan: true,
        creditDays: true,
        tags: true,
      },
    });
    if (!before) throw new NotFoundError('Distributor', id);

    if (dto.gstin && dto.gstin !== before.gstin) {
      const clash = await this.prisma.db.distributor.findFirst({
        where: { gstin: dto.gstin, id: { not: id } },
        select: { id: true },
      });
      if (clash) throw new AlreadyExistsError('distributor', 'gstin', dto.gstin);
    }

    const updated = await this.prisma.transaction(async (tx) => {
      const billingAddressId = dto.billingAddress
        ? await this.createAddress(tx, dto.billingAddress)
        : undefined;
      const shippingAddressId = dto.shippingAddress
        ? await this.createAddress(tx, dto.shippingAddress)
        : undefined;

      const result = await tx.distributor.update({
        where: { id },
        data: {
          ...(dto.legalName !== undefined ? { legalName: dto.legalName } : {}),
          ...(dto.tradeName !== undefined ? { tradeName: dto.tradeName } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.territoryId !== undefined ? { territoryId: dto.territoryId } : {}),
          ...(dto.accountManagerId !== undefined
            ? { accountManagerId: dto.accountManagerId }
            : {}),
          ...(dto.gstin !== undefined ? { gstin: dto.gstin } : {}),
          ...(dto.pan !== undefined ? { pan: dto.pan } : {}),
          ...(dto.tan !== undefined ? { tan: dto.tan } : {}),
          ...(dto.cin !== undefined ? { cin: dto.cin } : {}),
          ...(dto.msmeNumber !== undefined ? { msmeNumber: dto.msmeNumber } : {}),
          ...(dto.creditDays !== undefined ? { creditDays: dto.creditDays } : {}),
          ...(dto.paymentTermsCode !== undefined
            ? { paymentTermsCode: dto.paymentTermsCode }
            : {}),
          ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
          ...(dto.bankAccountName !== undefined
            ? { bankAccountName: dto.bankAccountName }
            : {}),
          ...(dto.bankIfsc !== undefined ? { bankIfsc: dto.bankIfsc } : {}),
          ...(dto.bankName !== undefined ? { bankName: dto.bankName } : {}),
          ...(dto.website !== undefined ? { website: dto.website || null } : {}),
          ...(dto.bankAccountNumber !== undefined
            ? {
                bankAccountEncrypted: dto.bankAccountNumber
                  ? this.encryption.encrypt(dto.bankAccountNumber)
                  : null,
              }
            : {}),
          ...(billingAddressId !== undefined ? { billingAddressId } : {}),
          ...(shippingAddressId !== undefined ? { shippingAddressId } : {}),
          updatedById: actorId,
        },
        select: DISTRIBUTOR_SELECT,
      });

      const diff = AuditService.diff(before, {
        legalName: result.legalName,
        tradeName: result.tradeName,
        type: result.type,
        territoryId: result.territoryId,
        accountManagerId: result.accountManagerId,
        gstin: result.gstin,
        pan: result.pan,
        creditDays: result.creditDays,
        tags: result.tags,
      });

      if (diff.changed.length) {
        const sensitive = AuditService.touchesSensitiveField(diff.changed);
        await this.audit.record(tx, {
          category: sensitive ? 'SECURITY' : 'DATA',
          action: 'distributor.updated',
          entityType: 'Distributor',
          entityId: id,
          before: diff.before,
          after: diff.after,
        });

        if (sensitive) {
          await this.outbox.emit(
            tx,
            DOMAIN_EVENTS.SECURITY_SENSITIVE_FIELD_CHANGED,
            { type: 'Distributor', id },
            {
              entityType: 'Distributor',
              entityId: id,
              fields: diff.changed.join(', '),
              userId: actorId,
            },
          );
        }
      }

      return result;
    });

    return this.toSummary(updated);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Approves a distributor: PENDING_APPROVAL → ACTIVE.
   *
   * Gated on verified KYC. Approving without a verified GST certificate and PAN
   * means the first invoice raised for this partner is legally defective, and
   * the correction path is a credit note rather than an edit.
   */
  async approve(id: string, actorId: string) {
    const distributor = await this.prisma.db.distributor.findFirst({
      where: { id },
      select: {
        id: true,
        code: true,
        status: true,
        gstin: true,
        legalName: true,
        documents: { select: { type: true, verifiedAt: true } },
        contacts: { select: { id: true }, take: 1 },
      },
    });
    if (!distributor) throw new NotFoundError('Distributor', id);

    this.assertTransition(distributor.status, 'ACTIVE');

    const missing = missingKyc(distributor.documents);
    if (missing.length > 0) {
      throw new ConflictError(
        `Cannot approve: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not yet verified. ` +
          'A distributor approved without verified KYC would produce legally defective invoices.',
      );
    }

    if (!distributor.gstin) {
      throw new ConflictError(
        'Cannot approve without a GSTIN — it determines the place-of-supply tax split on every invoice.',
      );
    }

    if (distributor.contacts.length === 0) {
      throw new ConflictError('Cannot approve without at least one contact person.');
    }

    return this.transition(id, 'ACTIVE', actorId, {
      action: 'distributor.approved',
      event: DOMAIN_EVENTS.DISTRIBUTOR_APPROVED,
      setOnboardedAt: true,
    });
  }

  async submitForApproval(id: string, actorId: string) {
    const current = await this.currentStatus(id);
    this.assertTransition(current, 'PENDING_APPROVAL');
    return this.transition(id, 'PENDING_APPROVAL', actorId, {
      action: 'distributor.submitted_for_approval',
    });
  }

  async suspend(id: string, reason: string, actorId: string) {
    const current = await this.currentStatus(id);
    this.assertTransition(current, 'SUSPENDED');
    return this.transition(id, 'SUSPENDED', actorId, {
      action: 'distributor.suspended',
      event: DOMAIN_EVENTS.DISTRIBUTOR_SUSPENDED,
      reason,
      setSuspendedAt: true,
    });
  }

  async reactivate(id: string, actorId: string) {
    const current = await this.currentStatus(id);

    /**
     * Guarded on the ACTION's own precondition, not on the transition table —
     * HANDOFF §4.21, met here a second time.
     *
     * `PENDING_APPROVAL → ACTIVE` is a legal move, because that is what
     * approval does. Guarding `reactivate()` with the table therefore handed it
     * that move too: a distributor awaiting approval could be made ACTIVE
     * through this endpoint, skipping the verified-KYC check, the GSTIN check
     * and the contact check that `approve()` performs, never recording
     * `onboardedAt`, and never emitting `distributor.approved`. The result was
     * a partner able to transact and be invoiced with no verified KYC at all.
     *
     * Reactivation means one thing: undoing a suspension. Anything else
     * reaching ACTIVE is an approval and must go through `approve()`.
     */
    if (current !== 'SUSPENDED') {
      throw new ConflictError(
        `Only a SUSPENDED distributor can be reactivated; this one is ${current}. ` +
          (current === 'PENDING_APPROVAL'
            ? 'Use approve, which checks KYC, the GSTIN, and that a contact exists.'
            : ''),
      );
    }

    this.assertTransition(current, 'ACTIVE');
    return this.transition(id, 'ACTIVE', actorId, { action: 'distributor.reactivated' });
  }

  async terminate(id: string, reason: string, actorId: string) {
    const current = await this.currentStatus(id);
    this.assertTransition(current, 'TERMINATED');
    return this.transition(id, 'TERMINATED', actorId, {
      action: 'distributor.terminated',
      reason,
    });
  }

  /**
   * Changes the credit limit.
   *
   * Its own endpoint, own permission, mandatory reason, and always a SECURITY
   * audit entry with the before/after. The limit is what stands between the
   * company and unrecoverable exposure, so it must never be changeable as a
   * side effect of editing a phone number.
   */
  async setCreditLimit(
    id: string,
    creditLimit: string,
    reason: string,
    actorId: string,
  ) {
    const before = await this.prisma.db.distributor.findFirst({
      where: { id },
      select: { id: true, code: true, creditLimit: true },
    });
    if (!before) throw new NotFoundError('Distributor', id);

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.distributor.update({
        where: { id },
        data: { creditLimit, updatedById: actorId },
        select: DISTRIBUTOR_SELECT,
      });

      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'distributor.credit_limit_changed',
        entityType: 'Distributor',
        entityId: id,
        before: { creditLimit: before.creditLimit.toFixed(4) },
        after: { creditLimit },
        metadata: { reason },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.DISTRIBUTOR_CREDIT_LIMIT_CHANGED,
        { type: 'Distributor', id },
        { code: before.code, from: before.creditLimit.toFixed(4), to: creditLimit, reason },
      );

      return result;
    });

    this.logger.warn(
      { distributorId: id, from: before.creditLimit.toFixed(4), to: creditLimit, actorId },
      'Credit limit changed',
    );

    return this.toSummary(updated);
  }

  private async transition(
    id: string,
    to: DistributorStatus,
    actorId: string,
    options: {
      action: string;
      event?: string;
      reason?: string;
      setOnboardedAt?: boolean;
      setSuspendedAt?: boolean;
    },
  ) {
    const before = await this.prisma.db.distributor.findFirst({
      where: { id },
      select: { id: true, code: true, status: true, legalName: true },
    });
    if (!before) throw new NotFoundError('Distributor', id);

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.distributor.update({
        where: { id },
        data: {
          status: to,
          statusReason: options.reason ?? null,
          ...(options.setOnboardedAt ? { onboardedAt: this.clock.now() } : {}),
          ...(options.setSuspendedAt ? { suspendedAt: this.clock.now() } : {}),
          updatedById: actorId,
        },
        select: DISTRIBUTOR_SELECT,
      });

      await this.audit.record(tx, {
        // A lifecycle change decides whether this partner can transact at all.
        category: 'SECURITY',
        action: options.action,
        entityType: 'Distributor',
        entityId: id,
        before: { status: before.status },
        after: { status: to },
        metadata: { reason: options.reason },
      });

      if (options.event) {
        await this.outbox.emit(
          tx,
          options.event as never,
          { type: 'Distributor', id },
          { code: before.code, legalName: before.legalName, status: to },
        );
      }

      return result;
    });

    this.logger.info(
      { distributorId: id, code: before.code, from: before.status, to },
      'Distributor status changed',
    );

    return this.toSummary(updated);
  }

  private assertTransition(from: DistributorStatus, to: DistributorStatus): void {
    if (!canTransitionDistributor(from, to)) {
      throw new InvalidStateTransitionError('distributor', from, to);
    }
  }

  private async currentStatus(id: string): Promise<DistributorStatus> {
    const row = await this.prisma.db.distributor.findFirst({
      where: { id },
      select: { status: true },
    });
    if (!row) throw new NotFoundError('Distributor', id);
    return row.status;
  }

  private async createAddress(tx: PrismaTransaction, address: AddressDto): Promise<string> {
    const created = await tx.address.create({
      data: {
        label: address.label ?? null,
        line1: address.line1,
        line2: address.line2 ?? null,
        landmark: address.landmark ?? null,
        cityId: address.cityId ?? null,
        cityName: address.cityName,
        stateId: address.stateId,
        postalCode: address.postalCode,
        countryCode: address.countryCode,
        contactName: address.contactName ?? null,
        contactPhone: address.contactPhone ?? null,
      },
      select: { id: true },
    });
    return created.id;
  }

  private toSummary(row: Prisma.DistributorGetPayload<{ select: typeof DISTRIBUTOR_SELECT }>) {
    let bankAccountMasked: string | null = null;
    if (row.bankAccountEncrypted) {
      try {
        bankAccountMasked = maskTailValue(this.encryption.decrypt(row.bankAccountEncrypted));
      } catch {
        // A value encrypted under a key that is no longer configured. Surfaced
        // as unavailable rather than crashing the whole list.
        bankAccountMasked = '••••';
      }
    }

    return {
      id: row.id,
      code: row.code,
      legalName: row.legalName,
      tradeName: row.tradeName,
      type: row.type,
      status: row.status,
      gstin: row.gstin,
      pan: row.pan,
      territoryId: row.territoryId,
      territoryName: row.territory?.name ?? null,
      accountManagerId: row.accountManagerId,
      accountManagerName: row.accountManager
        ? `${row.accountManager.firstName} ${row.accountManager.lastName}`
        : null,
      creditLimit: row.creditLimit.toFixed(4),
      creditDays: row.creditDays,
      bankAccountMasked,
      tags: row.tags,
      onboardedAt: row.onboardedAt,
      createdAt: row.createdAt,
      contactCount: row._count.contacts,
      kycVerified: missingKyc(row.documents).length === 0,
      kycMissing: missingKyc(row.documents),
    };
  }
}

/** KYC types still outstanding before approval is possible. */
function missingKyc(documents: Array<{ type: string; verifiedAt: Date | null }>): string[] {
  const verified = new Set(
    documents.filter((doc) => doc.verifiedAt !== null).map((doc) => doc.type),
  );
  return REQUIRED_KYC_FOR_APPROVAL.filter((required) => !verified.has(required));
}

