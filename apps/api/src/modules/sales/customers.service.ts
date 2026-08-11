import { Injectable } from '@nestjs/common';
import type {
  CreateCustomerContactDto,
  CreateCustomerDto,
  ListCustomersQuery,
  UpdateCustomerDto,
} from '@hixaa/contracts';
import type { AddressDto } from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import {
  AlreadyExistsError,
  ConflictError,
  NotFoundError,
} from '../../common/errors/domain.error';
import { keysetWhere, toListResult } from '../../common/utils/pagination.util';
import { AuditService } from '../../infrastructure/database/audit.service';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../infrastructure/database/prisma.service';
import { NumberSequenceService } from '../distributors/number-sequence.service';

/**
 * End customers — plants, mines, government bodies.
 *
 * Distinct from a Distributor, which is a channel partner. The separation is
 * what makes sell-in and sell-out separable at all: a PRIMARY order is
 * Hixaa → distributor, a SECONDARY order is distributor → customer.
 *
 * Territory-scoped, so a territory-scoped user sees only the customers in their
 * own subtree — registered in SCOPE_REGISTRY as `byTerritory()`.
 */
/** Exactly the leaves `addressSchema` accepts — see the distributor's twin. */
const CUSTOMER_ADDRESS_SELECT = {
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

const CUSTOMER_SELECT = {
  id: true,
  code: true,
  name: true,
  type: true,
  distributorId: true,
  territoryId: true,
  industryId: true,
  gstin: true,
  siteName: true,
  tags: true,
  isActive: true,
  createdAt: true,
  distributor: { select: { legalName: true } },
  territory: { select: { name: true } },
  industry: { select: { name: true } },
  _count: { select: { contacts: true, orders: true } },
} satisfies Prisma.CustomerSelect;

type CustomerRow = Prisma.CustomerGetPayload<{ select: typeof CUSTOMER_SELECT }>;

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sequences: NumberSequenceService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CustomersService.name);
  }

  async list(query: ListCustomersQuery) {
    const where: Prisma.CustomerWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.distributorId ? { distributorId: query.distributorId } : {}),
      ...(query.territoryId ? { territoryId: query.territoryId } : {}),
      ...(query.industryId ? { industryId: query.industryId } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { siteName: { contains: query.q, mode: 'insensitive' } },
              { code: { contains: query.q.toUpperCase() } },
              { gstin: { contains: query.q.toUpperCase() } },
            ],
          }
        : {}),
    };

    const cursorWhere = keysetWhere(query.cursor);
    const rows = await this.prisma.db.customer.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: CUSTOMER_SELECT,
    });

    const totalCount = query.includeTotal
      ? await this.prisma.db.customer.count({ where })
      : undefined;

    const result = toListResult(rows, query.limit, totalCount);
    return { ...result, data: result.data.map(toSummary) };
  }

  async findById(id: string) {
    const customer = await this.prisma.db.customer.findFirst({
      where: { id },
      select: CUSTOMER_SELECT,
    });
    if (!customer) throw new NotFoundError('Customer', id);
    return toSummary(customer);
  }

  async findDetail(id: string) {
    const summary = await this.findById(id);

    const [editable, contacts, recentOrders] = await Promise.all([
      // The fields the update DTO accepts but the summary omits, so an edit
      // form is pre-filled with what is stored rather than showing blanks that
      // read as "nothing on file". Same shape as the distributor's, and kept
      // out of CUSTOMER_SELECT for the same reason: that projection also serves
      // the list, and two address joins per row is a cost the list never uses.
      this.prisma.db.customer.findFirst({
        where: { id },
        select: {
          pan: true,
          website: true,
          notes: true,
          billingAddress: { select: CUSTOMER_ADDRESS_SELECT },
          shippingAddress: { select: CUSTOMER_ADDRESS_SELECT },
        },
      }),
      this.prisma.db.customerContact.findMany({
        where: { customerId: id },
        orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          designation: true,
          email: true,
          phone: true,
          isPrimary: true,
        },
      }),
      this.prisma.db.order.findMany({
        where: { customerId: id },
        orderBy: { orderDate: 'desc' },
        take: 20,
        select: {
          id: true,
          number: true,
          type: true,
          status: true,
          orderDate: true,
          grandTotal: true,
        },
      }),
    ]);

    return {
      ...summary,
      editable: {
        pan: editable?.pan ?? null,
        website: editable?.website ?? null,
        notes: editable?.notes ?? null,
        billingAddress: editable?.billingAddress ?? null,
        shippingAddress: editable?.shippingAddress ?? null,
      },
      contacts,
      recentOrders: recentOrders.map((order) => ({
        ...order,
        orderDate: order.orderDate.toISOString().slice(0, 10),
        grandTotal: order.grandTotal.toFixed(4),
      })),
      /**
       * The installed base — which serial-tracked units are deployed at this
       * customer's site. Populated once a distributor reports sell-out against
       * a serial; empty until then, which is the honest answer rather than a
       * fabricated one.
       */
      installedBase: await this.prisma.db.serialNumber.findMany({
        where: { currentCustomerId: id },
        orderBy: { dispatchedAt: 'desc' },
        take: 100,
        select: {
          id: true,
          serial: true,
          status: true,
          warrantyEnd: true,
          product: { select: { sku: true, name: true } },
        },
      }),
    };
  }

  async create(dto: CreateCustomerDto, actorId: string) {
    if (dto.gstin) {
      const clash = await this.prisma.db.customer.findFirst({
        where: { gstin: dto.gstin },
        select: { id: true, code: true },
      });
      if (clash) throw new AlreadyExistsError('customer', 'gstin', dto.gstin);
    }

    if (dto.code) {
      const clash = await this.prisma.db.customer.findFirst({
        where: { code: dto.code },
        select: { id: true },
      });
      if (clash) throw new AlreadyExistsError('customer', 'code', dto.code);
    }

    // A customer serviced by a distributor must be one the caller can see —
    // otherwise a scoped user could attach a customer to a partner outside
    // their territory and read it back through the relation.
    if (dto.distributorId) {
      const distributor = await this.prisma.db.distributor.findFirst({
        where: { id: dto.distributorId },
        select: { id: true, territoryId: true },
      });
      if (!distributor) throw new NotFoundError('Distributor', dto.distributorId);
      // Inherit the partner's territory when none was given, so the customer
      // lands inside the same scope boundary as the partner servicing it.
      if (!dto.territoryId && distributor.territoryId) {
        dto = { ...dto, territoryId: distributor.territoryId };
      }
    }

    const created = await this.prisma.transaction(async (tx) => {
      const code = dto.code ?? (await this.sequences.next(tx, 'CUSTOMER'));

      const billingAddressId = dto.billingAddress
        ? await this.createAddress(tx, dto.billingAddress)
        : null;
      const shippingAddressId = dto.shippingAddress
        ? await this.createAddress(tx, dto.shippingAddress)
        : null;

      const customer = await tx.customer.create({
        data: {
          code,
          name: dto.name,
          type: dto.type,
          distributorId: dto.distributorId ?? null,
          territoryId: dto.territoryId ?? null,
          industryId: dto.industryId ?? null,
          gstin: dto.gstin ?? null,
          pan: dto.pan ?? null,
          siteName: dto.siteName ?? null,
          website: dto.website || null,
          notes: dto.notes ?? null,
          tags: dto.tags,
          isActive: dto.isActive,
          billingAddressId,
          shippingAddressId,
          createdById: actorId,
        },
        select: CUSTOMER_SELECT,
      });

      await this.audit.record(tx, {
        action: 'customer.created',
        entityType: 'Customer',
        entityId: customer.id,
        after: { code, name: dto.name, type: dto.type, gstin: dto.gstin ?? null },
      });

      return customer;
    });

    this.logger.info({ customerId: created.id, code: created.code }, 'Customer created');
    return toSummary(created);
  }

  async update(id: string, dto: UpdateCustomerDto, actorId: string) {
    const before = await this.prisma.db.customer.findFirst({
      where: { id },
      select: {
        id: true,
        name: true,
        type: true,
        gstin: true,
        distributorId: true,
        territoryId: true,
        industryId: true,
        siteName: true,
        isActive: true,
        tags: true,
      },
    });
    if (!before) throw new NotFoundError('Customer', id);

    if (dto.gstin && dto.gstin !== before.gstin) {
      const clash = await this.prisma.db.customer.findFirst({
        where: { gstin: dto.gstin, id: { not: id } },
        select: { id: true },
      });
      if (clash) throw new AlreadyExistsError('customer', 'gstin', dto.gstin);
    }

    const updated = await this.prisma.transaction(async (tx) => {
      const billingAddressId = dto.billingAddress
        ? await this.createAddress(tx, dto.billingAddress)
        : undefined;
      const shippingAddressId = dto.shippingAddress
        ? await this.createAddress(tx, dto.shippingAddress)
        : undefined;

      const result = await tx.customer.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.distributorId !== undefined ? { distributorId: dto.distributorId } : {}),
          ...(dto.territoryId !== undefined ? { territoryId: dto.territoryId } : {}),
          ...(dto.industryId !== undefined ? { industryId: dto.industryId } : {}),
          ...(dto.gstin !== undefined ? { gstin: dto.gstin } : {}),
          ...(dto.pan !== undefined ? { pan: dto.pan } : {}),
          ...(dto.siteName !== undefined ? { siteName: dto.siteName } : {}),
          ...(dto.website !== undefined ? { website: dto.website || null } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(billingAddressId !== undefined ? { billingAddressId } : {}),
          ...(shippingAddressId !== undefined ? { shippingAddressId } : {}),
          updatedById: actorId,
        },
        select: CUSTOMER_SELECT,
      });

      const diff = AuditService.diff(before, {
        name: result.name,
        type: result.type,
        gstin: result.gstin,
        distributorId: result.distributorId,
        territoryId: result.territoryId,
        industryId: result.industryId,
        siteName: result.siteName,
        isActive: result.isActive,
        tags: result.tags,
      });

      if (diff.changed.length) {
        const sensitive = AuditService.touchesSensitiveField(diff.changed);
        await this.audit.record(tx, {
          category: sensitive ? 'SECURITY' : 'DATA',
          action: 'customer.updated',
          entityType: 'Customer',
          entityId: id,
          before: diff.before,
          after: diff.after,
        });
      }

      return result;
    });

    return toSummary(updated);
  }

  async addContact(customerId: string, dto: CreateCustomerContactDto, actorId: string) {
    await this.assertVisible(customerId);

    return this.prisma.transaction(async (tx) => {
      // Exactly one primary contact, or nothing can say who to address.
      if (dto.isPrimary) {
        await tx.customerContact.updateMany({
          where: { customerId, isPrimary: true },
          data: { isPrimary: false },
        });
      }

      const contact = await tx.customerContact.create({
        data: {
          customerId,
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
        action: 'customer.contact_added',
        entityType: 'Customer',
        entityId: customerId,
        after: { name: dto.name, email: dto.email ?? null },
        metadata: { actorId },
      });

      return contact;
    });
  }

  async removeContact(customerId: string, contactId: string, actorId: string): Promise<void> {
    await this.assertVisible(customerId);

    const contact = await this.prisma.db.customerContact.findFirst({
      where: { id: contactId, customerId },
      select: { id: true, name: true },
    });
    if (!contact) throw new NotFoundError('Customer contact', contactId);

    await this.prisma.transaction(async (tx) => {
      await tx.customerContact.softDelete({ id: contactId });
      await this.audit.record(tx, {
        action: 'customer.contact_removed',
        entityType: 'Customer',
        entityId: customerId,
        before: { name: contact.name },
        metadata: { actorId },
      });
    });
  }

  async remove(id: string, actorId: string): Promise<void> {
    const customer = await this.prisma.db.customer.findFirst({
      where: { id },
      select: { id: true, code: true, _count: { select: { orders: true } } },
    });
    if (!customer) throw new NotFoundError('Customer', id);

    // Refused rather than cascaded: an order names its counterparty, and
    // deleting one would orphan a commercial document.
    if (customer._count.orders > 0) {
      throw new ConflictError(
        `Cannot delete ${customer.code}: ${customer._count.orders} order(s) reference it. ` +
          'Deactivate the customer instead — the history must stay intact.',
      );
    }

    await this.prisma.transaction(async (tx) => {
      await tx.customer.softDelete({ id });
      await this.audit.record(tx, {
        action: 'customer.deleted',
        entityType: 'Customer',
        entityId: id,
        before: { code: customer.code },
        metadata: { actorId },
      });
    });
  }

  /** Reads through the scoped client, so an out-of-scope customer is a 404. */
  private async assertVisible(id: string): Promise<void> {
    const customer = await this.prisma.db.customer.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!customer) throw new NotFoundError('Customer', id);
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
}

function toSummary(row: CustomerRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    distributorId: row.distributorId,
    distributorName: row.distributor?.legalName ?? null,
    territoryId: row.territoryId,
    territoryName: row.territory?.name ?? null,
    industryId: row.industryId,
    industryName: row.industry?.name ?? null,
    gstin: row.gstin,
    siteName: row.siteName,
    tags: row.tags,
    isActive: row.isActive,
    contactCount: row._count.contacts,
    orderCount: row._count.orders,
    createdAt: row.createdAt,
  };
}
