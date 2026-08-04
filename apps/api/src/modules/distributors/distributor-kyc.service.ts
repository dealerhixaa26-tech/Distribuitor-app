import { Injectable } from '@nestjs/common';
import { DOMAIN_EVENTS, REQUIRED_KYC_FOR_APPROVAL } from '@hixaa/contracts';
import type { KycDocumentType } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import { ConflictError, NotFoundError } from '../../common/errors/domain.error';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';

/** Warn this many days before a certificate lapses. */
const EXPIRY_WARNING_DAYS = 30;

/**
 * KYC attachment and verification.
 *
 * Separated from `DistributorsService` because verification is a different
 * authority from editing a distributor: attaching a document needs
 * `distributor:document:manage`, verifying one needs `distributor:approve`.
 * Whoever uploads a GST certificate should not be the one who attests it is
 * genuine.
 */
@Injectable()
export class DistributorKycService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DistributorKycService.name);
  }

  /** Attaches an already-uploaded document as KYC evidence. */
  async attach(
    distributorId: string,
    documentId: string,
    type: KycDocumentType,
    expiresAt: string | undefined,
    actorId: string,
  ) {
    const [distributor, document] = await Promise.all([
      this.prisma.db.distributor.findFirst({
        where: { id: distributorId },
        select: { id: true, code: true },
      }),
      this.prisma.db.document.findFirst({
        where: { id: documentId },
        select: { id: true, scanStatus: true, originalName: true },
      }),
    ]);

    if (!distributor) throw new NotFoundError('Distributor', distributorId);
    if (!document) throw new NotFoundError('Document', documentId);

    // A file still awaiting a scan must not become evidence of anything.
    if (document.scanStatus === 'PENDING') {
      throw new ConflictError('This file is still being scanned. Try again in a moment.');
    }
    if (document.scanStatus === 'INFECTED') {
      throw new ConflictError('This file failed a malware scan and cannot be attached.');
    }

    const record = await this.prisma.transaction(async (tx) => {
      const created = await tx.distributorDocument.upsert({
        where: { distributorId_type_documentId: { distributorId, type, documentId } },
        create: {
          distributorId,
          documentId,
          type,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        },
        update: { expiresAt: expiresAt ? new Date(expiresAt) : null },
        select: { id: true, type: true, verifiedAt: true, expiresAt: true },
      });

      await this.audit.record(tx, {
        action: 'distributor.kyc_attached',
        entityType: 'Distributor',
        entityId: distributorId,
        after: { type, documentId, fileName: document.originalName },
        metadata: { actorId },
      });

      return created;
    });

    return record;
  }

  /**
   * Verifies or rejects a KYC document.
   *
   * Verification is what unlocks approval, so the actor and the moment are both
   * recorded — this is the evidence that someone with authority actually looked
   * at the certificate.
   */
  async verify(
    distributorId: string,
    kycId: string,
    approved: boolean,
    rejectionReason: string | undefined,
    actorId: string,
  ) {
    const record = await this.prisma.db.distributorDocument.findFirst({
      where: { id: kycId, distributorId },
      select: { id: true, type: true, verifiedAt: true, rejectedAt: true },
    });
    if (!record) throw new NotFoundError('KYC document', kycId);

    if (!approved && !rejectionReason) {
      throw new ConflictError('A rejection reason is required.');
    }

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.distributorDocument.update({
        where: { id: kycId },
        data: approved
          ? {
              verifiedAt: this.clock.now(),
              verifiedById: actorId,
              rejectedAt: null,
              rejectionReason: null,
            }
          : {
              rejectedAt: this.clock.now(),
              rejectionReason: rejectionReason ?? null,
              verifiedAt: null,
              verifiedById: null,
            },
        select: { id: true, type: true, verifiedAt: true, rejectedAt: true, rejectionReason: true },
      });

      await this.audit.record(tx, {
        // Verification is what unlocks the ability to transact.
        category: 'SECURITY',
        action: approved ? 'distributor.kyc_verified' : 'distributor.kyc_rejected',
        entityType: 'Distributor',
        entityId: distributorId,
        before: { type: record.type, verified: Boolean(record.verifiedAt) },
        after: { type: record.type, verified: approved },
        metadata: { kycId, reason: rejectionReason },
      });

      return result;
    });

    this.logger.info(
      { distributorId, kycId, type: record.type, approved, actorId },
      'KYC document reviewed',
    );

    return updated;
  }

  async remove(distributorId: string, kycId: string, actorId: string): Promise<void> {
    const record = await this.prisma.db.distributorDocument.findFirst({
      where: { id: kycId, distributorId },
      select: { id: true, type: true, verifiedAt: true },
    });
    if (!record) throw new NotFoundError('KYC document', kycId);

    // Removing verified evidence from an approved partner would leave them
    // transacting on a basis nobody can produce. Reject rather than allow a
    // quiet gap in the record.
    const distributor = await this.prisma.db.distributor.findFirst({
      where: { id: distributorId },
      select: { status: true },
    });
    if (record.verifiedAt && distributor?.status === 'ACTIVE') {
      throw new ConflictError(
        'Cannot remove verified KYC from an active distributor. Suspend them first if the ' +
          'evidence is no longer valid.',
      );
    }

    await this.prisma.transaction(async (tx) => {
      await tx.distributorDocument.delete({ where: { id: kycId } });
      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'distributor.kyc_removed',
        entityType: 'Distributor',
        entityId: distributorId,
        before: { type: record.type, verified: Boolean(record.verifiedAt) },
        metadata: { actorId },
      });
    });
  }

  /**
   * Finds KYC nearing expiry, so a certificate lapsing does not silently
   * invalidate a partner's compliance.
   *
   * Called by a scheduled job; also exposed so an admin can see the queue.
   */
  async expiring(withinDays = EXPIRY_WARNING_DAYS) {
    const cutoff = this.clock.plusDays(withinDays);

    const rows = await this.prisma.db.distributorDocument.findMany({
      where: {
        expiresAt: { not: null, lte: cutoff },
        verifiedAt: { not: null },
        distributor: { status: { in: ['ACTIVE', 'PENDING_APPROVAL'] } },
      },
      orderBy: { expiresAt: 'asc' },
      select: {
        id: true,
        type: true,
        expiresAt: true,
        distributor: { select: { id: true, code: true, legalName: true, status: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      expiresAt: row.expiresAt,
      expired: row.expiresAt !== null && row.expiresAt < this.clock.now(),
      distributor: row.distributor,
    }));
  }

  /** Raises an ops notification for each expiring certificate. */
  async notifyExpiring(): Promise<number> {
    const expiring = await this.expiring();
    if (expiring.length === 0) return 0;

    await this.prisma.transaction(async (tx) => {
      for (const item of expiring) {
        await this.outbox.emit(
          tx,
          DOMAIN_EVENTS.DISTRIBUTOR_DOCUMENT_EXPIRING,
          { type: 'Distributor', id: item.distributor.id },
          {
            code: item.distributor.code,
            legalName: item.distributor.legalName,
            documentType: item.type,
            expiresAt: item.expiresAt?.toISOString() ?? '',
            expired: String(item.expired),
          },
        );
      }
    });

    this.logger.info({ count: expiring.length }, 'KYC expiry notifications queued');
    return expiring.length;
  }

  /** The KYC types still outstanding before this distributor can be approved. */
  async missingForApproval(distributorId: string): Promise<string[]> {
    const documents = await this.prisma.db.distributorDocument.findMany({
      where: { distributorId, verifiedAt: { not: null } },
      select: { type: true },
    });
    const verified = new Set(documents.map((doc) => doc.type));
    return REQUIRED_KYC_FOR_APPROVAL.filter((required) => !verified.has(required));
  }
}
