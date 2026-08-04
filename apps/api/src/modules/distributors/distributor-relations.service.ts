import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ConflictError, NotFoundError } from '../../common/errors/domain.error';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/**
 * Contacts, notes, and agreements.
 *
 * Split from `DistributorsService` to keep that class about the distributor's
 * own lifecycle and commercial terms. These are satellites — related records
 * that hang off a distributor without changing what it is.
 */
@Injectable()
export class DistributorRelationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DistributorRelationsService.name);
  }

  private async assertDistributorVisible(distributorId: string): Promise<void> {
    // Reads through the scoped client, so a caller outside the distributor's
    // territory gets a 404 here rather than being allowed to attach a contact
    // to a record they cannot see.
    const exists = await this.prisma.db.distributor.findFirst({
      where: { id: distributorId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundError('Distributor', distributorId);
  }

  async addContact(
    distributorId: string,
    dto: { name: string; designation?: string; email?: string; phone?: string; isPrimary: boolean },
    actorId: string,
  ) {
    await this.assertDistributorVisible(distributorId);

    return this.prisma.transaction(async (tx) => {
      // Exactly one primary contact: demote any existing one rather than
      // ending up with two and no way to tell which the system should use.
      if (dto.isPrimary) {
        await tx.distributorContact.updateMany({
          where: { distributorId, isPrimary: true },
          data: { isPrimary: false },
        });
      }

      const contact = await tx.distributorContact.create({
        data: {
          distributorId,
          name: dto.name,
          designation: dto.designation ?? null,
          email: dto.email ?? null,
          phone: dto.phone ?? null,
          isPrimary: dto.isPrimary,
        },
        select: {
          id: true,
          name: true,
          designation: true,
          email: true,
          phone: true,
          isPrimary: true,
        },
      });

      await this.audit.record(tx, {
        action: 'distributor.contact_added',
        entityType: 'Distributor',
        entityId: distributorId,
        after: { name: dto.name, email: dto.email ?? null, isPrimary: dto.isPrimary },
        metadata: { actorId, contactId: contact.id },
      });

      return contact;
    });
  }

  async removeContact(distributorId: string, contactId: string, actorId: string): Promise<void> {
    await this.assertDistributorVisible(distributorId);

    const contact = await this.prisma.db.distributorContact.findFirst({
      where: { id: contactId, distributorId },
      select: { id: true, name: true, portalUserId: true },
    });
    if (!contact) throw new NotFoundError('Contact', contactId);

    // A contact linked to a portal user is that person's identity in the
    // system. Removing it silently would orphan their account.
    if (contact.portalUserId) {
      throw new ConflictError(
        'This contact is linked to a portal user account. Revoke their portal access first.',
      );
    }

    const remaining = await this.prisma.db.distributorContact.count({
      where: { distributorId, id: { not: contactId } },
    });
    const distributor = await this.prisma.db.distributor.findFirst({
      where: { id: distributorId },
      select: { status: true },
    });

    // An active distributor with no contact is one nobody can reach about a
    // dispatch or an overdue invoice.
    if (remaining === 0 && distributor?.status === 'ACTIVE') {
      throw new ConflictError('An active distributor must have at least one contact.');
    }

    await this.prisma.transaction(async (tx) => {
      await tx.distributorContact.softDelete({ id: contactId });
      await this.audit.record(tx, {
        action: 'distributor.contact_removed',
        entityType: 'Distributor',
        entityId: distributorId,
        before: { name: contact.name },
        metadata: { actorId },
      });
    });
  }

  async addNote(distributorId: string, body: string, isPinned: boolean, actorId: string) {
    await this.assertDistributorVisible(distributorId);

    const note = await this.prisma.db.distributorNote.create({
      data: { distributorId, body, isPinned, authorId: actorId },
      select: {
        id: true,
        body: true,
        isPinned: true,
        createdAt: true,
        author: { select: { firstName: true, lastName: true } },
      },
    });

    // Notes are commentary, not a state change — recorded, but not audited as
    // a mutation of the distributor itself.
    return {
      id: note.id,
      body: note.body,
      isPinned: note.isPinned,
      createdAt: note.createdAt,
      authorName: note.author ? `${note.author.firstName} ${note.author.lastName}` : null,
    };
  }

  async addAgreement(
    distributorId: string,
    dto: {
      reference?: string;
      startDate: string;
      endDate?: string;
      targetAmount?: string;
      documentId?: string;
      notes?: string;
    },
    actorId: string,
  ) {
    await this.assertDistributorVisible(distributorId);

    return this.prisma.transaction(async (tx) => {
      const agreement = await tx.agreement.create({
        data: {
          distributorId,
          reference: dto.reference ?? null,
          startDate: new Date(dto.startDate),
          endDate: dto.endDate ? new Date(dto.endDate) : null,
          targetAmount: dto.targetAmount ?? null,
          documentId: dto.documentId ?? null,
          notes: dto.notes ?? null,
          status: 'DRAFT',
        },
        select: {
          id: true,
          reference: true,
          startDate: true,
          endDate: true,
          targetAmount: true,
          status: true,
        },
      });

      await this.audit.record(tx, {
        action: 'distributor.agreement_added',
        entityType: 'Distributor',
        entityId: distributorId,
        after: {
          reference: dto.reference ?? null,
          startDate: dto.startDate,
          targetAmount: dto.targetAmount ?? null,
        },
        metadata: { actorId, agreementId: agreement.id },
      });

      return agreement;
    });
  }
}
