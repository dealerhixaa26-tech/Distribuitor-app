import { Injectable } from '@nestjs/common';
import type {
  CreateWarehouseDto,
  ListWarehousesQuery,
  UpdateWarehouseDto,
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

/**
 * Warehouses.
 *
 * Scoped by territory since Phase 3 (`warehouse: byTerritory()` in
 * SCOPE_REGISTRY), so a territory-scoped caller only ever sees their own — and
 * that scoping is what makes the inventory models hanging off a warehouse
 * scopeable in turn.
 */
const WAREHOUSE_SELECT = {
  id: true,
  code: true,
  name: true,
  type: true,
  distributorId: true,
  territoryId: true,
  isDefault: true,
  isActive: true,
  createdAt: true,
  territory: { select: { name: true } },
  distributor: { select: { legalName: true } },
  _count: { select: { balances: true } },
} satisfies Prisma.WarehouseSelect;

type WarehouseRow = Prisma.WarehouseGetPayload<{ select: typeof WAREHOUSE_SELECT }>;

@Injectable()
export class WarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WarehousesService.name);
  }

  async list(query: ListWarehousesQuery) {
    const where: Prisma.WarehouseWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.territoryId ? { territoryId: query.territoryId } : {}),
      ...(query.distributorId ? { distributorId: query.distributorId } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { code: { contains: query.q.toUpperCase() } },
            ],
          }
        : {}),
    };

    const cursorWhere = keysetWhere(query.cursor);
    const rows = await this.prisma.db.warehouse.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: WAREHOUSE_SELECT,
    });

    const totalCount = query.includeTotal
      ? await this.prisma.db.warehouse.count({ where })
      : undefined;

    const result = toListResult(rows, query.limit, totalCount);
    return { ...result, data: result.data.map(toSummary) };
  }

  async findById(id: string) {
    const warehouse = await this.prisma.db.warehouse.findFirst({
      where: { id },
      select: WAREHOUSE_SELECT,
    });
    if (!warehouse) throw new NotFoundError('Warehouse', id);
    return toSummary(warehouse);
  }

  async create(dto: CreateWarehouseDto, actorId: string) {
    const existing = await this.prisma.db.warehouse.findFirst({
      where: { code: dto.code },
      select: { id: true },
    });
    if (existing) throw new AlreadyExistsError('warehouse', 'code', dto.code);

    // Mirrors the CHECK constraint and the Zod refinement. Checked here too
    // because an internal caller bypasses the pipe — and mixing these up would
    // count a partner's stock as Hixaa's own.
    this.assertDistributorMatchesType(dto.type, dto.distributorId);

    if (dto.distributorId) {
      const distributor = await this.prisma.db.distributor.findFirst({
        where: { id: dto.distributorId },
        select: { id: true },
      });
      if (!distributor) throw new NotFoundError('Distributor', dto.distributorId);
    }

    const created = await this.prisma.transaction(async (tx) => {
      if (dto.isDefault) await this.demoteExistingDefault(tx, null);

      const addressId = dto.address ? await this.createAddress(tx, dto.address) : null;

      const warehouse = await tx.warehouse.create({
        data: {
          code: dto.code,
          name: dto.name,
          type: dto.type,
          distributorId: dto.distributorId ?? null,
          territoryId: dto.territoryId ?? null,
          addressId,
          isDefault: dto.isDefault,
          isActive: dto.isActive,
          createdById: actorId,
        },
        select: WAREHOUSE_SELECT,
      });

      await this.audit.record(tx, {
        action: 'warehouse.created',
        entityType: 'Warehouse',
        entityId: warehouse.id,
        after: { code: dto.code, name: dto.name, type: dto.type },
      });

      return warehouse;
    });

    this.logger.info({ warehouseId: created.id, code: created.code }, 'Warehouse created');
    return toSummary(created);
  }

  async update(id: string, dto: UpdateWarehouseDto, actorId: string) {
    const before = await this.prisma.db.warehouse.findFirst({
      where: { id },
      select: { id: true, code: true, name: true, territoryId: true, isActive: true, isDefault: true },
    });
    if (!before) throw new NotFoundError('Warehouse', id);

    const updated = await this.prisma.transaction(async (tx) => {
      if (dto.isDefault === true) await this.demoteExistingDefault(tx, id);

      const addressId = dto.address ? await this.createAddress(tx, dto.address) : undefined;

      const result = await tx.warehouse.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.territoryId !== undefined ? { territoryId: dto.territoryId } : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(addressId !== undefined ? { addressId } : {}),
        },
        select: WAREHOUSE_SELECT,
      });

      const diff = AuditService.diff(before, {
        name: result.name,
        territoryId: result.territoryId,
        isActive: result.isActive,
        isDefault: result.isDefault,
      });

      if (diff.changed.length) {
        await this.audit.record(tx, {
          action: 'warehouse.updated',
          entityType: 'Warehouse',
          entityId: id,
          before: diff.before,
          after: diff.after,
          metadata: { actorId },
        });
      }

      return result;
    });

    return toSummary(updated);
  }

  async setDefault(id: string, actorId: string) {
    await this.findById(id);

    const updated = await this.prisma.transaction(async (tx) => {
      await this.demoteExistingDefault(tx, id);
      const result = await tx.warehouse.update({
        where: { id },
        data: { isDefault: true },
        select: WAREHOUSE_SELECT,
      });
      await this.audit.record(tx, {
        action: 'warehouse.set_default',
        entityType: 'Warehouse',
        entityId: id,
        after: { isDefault: true },
        metadata: { actorId },
      });
      return result;
    });

    return toSummary(updated);
  }

  async remove(id: string, actorId: string): Promise<void> {
    const warehouse = await this.prisma.db.warehouse.findFirst({
      where: { id },
      select: {
        id: true,
        code: true,
        isDefault: true,
        _count: { select: { ledgerEntries: true, balances: true } },
      },
    });
    if (!warehouse) throw new NotFoundError('Warehouse', id);

    if (warehouse.isDefault) {
      throw new ConflictError(
        `${warehouse.code} is the default warehouse. Make another the default before deleting it.`,
      );
    }

    // Refused rather than cascaded. Deleting a warehouse with movement history
    // would orphan an append-only ledger — the one table whose whole value is
    // that it explains where stock went.
    if (warehouse._count.ledgerEntries > 0) {
      throw new ConflictError(
        `Cannot delete ${warehouse.code}: it has ${warehouse._count.ledgerEntries} stock movements ` +
          'in the ledger. Deactivate it instead — the history must stay intact.',
      );
    }

    await this.prisma.transaction(async (tx) => {
      await tx.warehouse.softDelete({ id });
      await this.audit.record(tx, {
        action: 'warehouse.deleted',
        entityType: 'Warehouse',
        entityId: id,
        before: { code: warehouse.code },
        metadata: { actorId },
      });
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private assertDistributorMatchesType(type: string, distributorId?: string): void {
    if (type === 'DISTRIBUTOR' && !distributorId) {
      throw new ConflictError('A distributor warehouse must name the distributor that owns it.');
    }
    if (type !== 'DISTRIBUTOR' && distributorId) {
      throw new ConflictError(
        `A ${type} warehouse is Hixaa's own and cannot belong to a distributor.`,
      );
    }
  }

  /** The partial unique index makes two defaults impossible; this stops that
   *  constraint surfacing to the user as a raw database error. */
  private async demoteExistingDefault(
    tx: PrismaTransaction,
    exceptId: string | null,
  ): Promise<void> {
    await tx.warehouse.updateMany({
      where: { isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
      data: { isDefault: false },
    });
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

function toSummary(row: WarehouseRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    distributorId: row.distributorId,
    distributorName: row.distributor?.legalName ?? null,
    territoryId: row.territoryId,
    territoryName: row.territory?.name ?? null,
    isDefault: row.isDefault,
    isActive: row.isActive,
    stockedProductCount: row._count.balances,
    createdAt: row.createdAt,
  };
}
