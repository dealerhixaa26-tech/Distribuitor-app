import { Injectable } from '@nestjs/common';
import {
  DOMAIN_EVENTS,
  Money,
  canTransitionPriceList,
  type ClonePriceListDto,
  type CreatePriceListDto,
  type ListPriceListsQuery,
  type PriceListItemDto,
  type UpdatePriceListDto,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import {
  AlreadyExistsError,
  ConflictError,
  NotFoundError,
} from '../../common/errors/domain.error';
import { keysetWhere, toListResult } from '../../common/utils/pagination.util';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService, type PrismaTransaction } from '../../infrastructure/database/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';

/**
 * Price lists.
 *
 * Versioned by CLONING, never by editing a live list. Republishing a list that
 * distributors are already quoting against would silently reprice every order
 * still under negotiation, and there would be no record of what the old price
 * had been. Clone → adjust → publish leaves both versions intact.
 *
 * All prices here are GST-exclusive (ADR-0008).
 */
const PRICE_LIST_SELECT = {
  id: true,
  code: true,
  name: true,
  status: true,
  currency: true,
  priceBasis: true,
  validFrom: true,
  validTo: true,
  isDefault: true,
  version: true,
  clonedFromId: true,
  publishedAt: true,
  createdAt: true,
  _count: { select: { items: true, distributors: true } },
} satisfies Prisma.PriceListSelect;

type PriceListRow = Prisma.PriceListGetPayload<{ select: typeof PRICE_LIST_SELECT }>;

@Injectable()
export class PriceListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PriceListsService.name);
  }

  async list(query: ListPriceListsQuery) {
    const where: Prisma.PriceListWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
    };

    if (query.activeOn) {
      const on = new Date(`${query.activeOn}T00:00:00.000Z`);
      where.validFrom = { lte: on };
      where.OR = [{ validTo: null }, { validTo: { gte: on } }];
    }

    const cursorWhere = keysetWhere(query.cursor);
    const rows = await this.prisma.db.priceList.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: PRICE_LIST_SELECT,
    });

    const totalCount = query.includeTotal
      ? await this.prisma.db.priceList.count({ where })
      : undefined;

    const result = toListResult(rows, query.limit, totalCount);
    return { ...result, data: result.data.map(toSummary) };
  }

  async findById(id: string) {
    const priceList = await this.prisma.db.priceList.findFirst({
      where: { id },
      select: PRICE_LIST_SELECT,
    });
    if (!priceList) throw new NotFoundError('PriceList', id);
    return toSummary(priceList);
  }

  async items(id: string) {
    await this.findById(id);

    const rows = await this.prisma.db.priceListItem.findMany({
      where: { priceListId: id },
      orderBy: [{ product: { sku: 'asc' } }, { minQty: 'asc' }],
      select: {
        id: true,
        productId: true,
        variantId: true,
        minQty: true,
        price: true,
        minPrice: true,
        product: { select: { sku: true, name: true, type: true, status: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      productId: row.productId,
      variantId: row.variantId,
      sku: row.product.sku,
      name: row.product.name,
      type: row.product.type,
      productStatus: row.product.status,
      minQty: row.minQty.toFixed(4),
      price: row.price.toFixed(4),
      minPrice: row.minPrice ? row.minPrice.toFixed(4) : null,
    }));
  }

  async create(dto: CreatePriceListDto, actorId: string) {
    const existing = await this.prisma.db.priceList.findFirst({
      where: { code: dto.code },
      select: { id: true },
    });
    if (existing) throw new AlreadyExistsError('price list', 'code', dto.code);

    const created = await this.prisma.transaction(async (tx) => {
      if (dto.isDefault) await this.demoteExistingDefault(tx, null);

      const priceList = await tx.priceList.create({
        data: {
          code: dto.code,
          name: dto.name,
          // Always DRAFT. A list that arrives already ACTIVE could be quoted
          // from before a single price had been entered into it.
          status: 'DRAFT',
          currency: dto.currency,
          priceBasis: dto.priceBasis,
          validFrom: new Date(`${dto.validFrom}T00:00:00.000Z`),
          validTo: dto.validTo ? new Date(`${dto.validTo}T00:00:00.000Z`) : null,
          isDefault: dto.isDefault,
          description: dto.description ?? null,
          createdById: actorId,
        },
        select: PRICE_LIST_SELECT,
      });

      await this.audit.record(tx, {
        action: 'pricelist.created',
        entityType: 'PriceList',
        entityId: priceList.id,
        after: { code: dto.code, name: dto.name, validFrom: dto.validFrom },
      });

      return priceList;
    });

    this.logger.info({ priceListId: created.id, code: created.code }, 'Price list created');
    return toSummary(created);
  }

  async update(id: string, dto: UpdatePriceListDto, actorId: string) {
    const before = await this.prisma.db.priceList.findFirst({
      where: { id },
      select: { id: true, code: true, name: true, status: true, isDefault: true, validFrom: true, validTo: true },
    });
    if (!before) throw new NotFoundError('PriceList', id);

    if (before.status === 'ARCHIVED') {
      throw new ConflictError(
        `Price list ${before.code} is archived. Clone it to make changes — an archived list is history.`,
      );
    }

    const updated = await this.prisma.transaction(async (tx) => {
      if (dto.isDefault === true) await this.demoteExistingDefault(tx, id);

      const result = await tx.priceList.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.validFrom !== undefined
            ? { validFrom: new Date(`${dto.validFrom}T00:00:00.000Z`) }
            : {}),
          ...(dto.validTo !== undefined
            ? { validTo: dto.validTo ? new Date(`${dto.validTo}T00:00:00.000Z`) : null }
            : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          updatedById: actorId,
        },
        select: PRICE_LIST_SELECT,
      });

      await this.audit.record(tx, {
        action: 'pricelist.updated',
        entityType: 'PriceList',
        entityId: id,
        before: { name: before.name, isDefault: before.isDefault },
        after: { name: result.name, isDefault: result.isDefault },
      });

      return result;
    });

    return toSummary(updated);
  }

  /**
   * Bulk upsert of price points.
   *
   * One transaction: a half-applied price list is worse than an unchanged one,
   * because it is internally inconsistent and nothing says so.
   */
  async upsertItems(
    id: string,
    items: readonly PriceListItemDto[],
    replaceAll: boolean,
    actorId: string,
  ) {
    const priceList = await this.prisma.db.priceList.findFirst({
      where: { id },
      select: { id: true, code: true, status: true },
    });
    if (!priceList) throw new NotFoundError('PriceList', id);

    if (priceList.status === 'ARCHIVED') {
      throw new ConflictError(`Price list ${priceList.code} is archived and cannot be edited.`);
    }

    // Every referenced product must exist. Checked up front so the transaction
    // does not fail halfway with some rows applied.
    const productIds = [...new Set(items.map((item) => item.productId))];
    const found = await this.prisma.db.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true },
    });
    if (found.length !== productIds.length) {
      const known = new Set(found.map((product) => product.id));
      const missing = productIds.filter((productId) => !known.has(productId));
      throw new NotFoundError('Product', missing.join(', '));
    }

    return this.prisma.transaction(async (tx) => {
      if (replaceAll) {
        await tx.priceListItem.deleteMany({ where: { priceListId: id } });
      }

      for (const item of items) {
        // Uniqueness is enforced by two PARTIAL indexes (nullable variantId),
        // so a plain `upsert` on a compound unique is not available here.
        const existing = await tx.priceListItem.findFirst({
          where: {
            priceListId: id,
            productId: item.productId,
            variantId: item.variantId ?? null,
            minQty: item.minQty,
          },
          select: { id: true },
        });

        const data = {
          price: item.price,
          minPrice: item.minPrice ?? null,
        };

        if (existing) {
          await tx.priceListItem.update({ where: { id: existing.id }, data });
        } else {
          await tx.priceListItem.create({
            data: {
              priceListId: id,
              productId: item.productId,
              variantId: item.variantId ?? null,
              minQty: item.minQty,
              ...data,
            },
          });
        }
      }

      await this.audit.record(tx, {
        action: 'pricelist.items_upserted',
        entityType: 'PriceList',
        entityId: id,
        after: { itemCount: items.length, replaceAll },
        metadata: { actorId },
      });

      return { updated: items.length, replaceAll };
    });
  }

  /**
   * Clones a list into a new DRAFT version, optionally adjusting every price.
   *
   * This is how a price revision happens: the live list keeps serving orders
   * under negotiation while the new one is prepared and reviewed.
   */
  async clone(id: string, dto: ClonePriceListDto, actorId: string) {
    const source = await this.prisma.db.priceList.findFirst({
      where: { id },
      select: { id: true, code: true, name: true, currency: true, priceBasis: true, version: true },
    });
    if (!source) throw new NotFoundError('PriceList', id);

    const clash = await this.prisma.db.priceList.findFirst({
      where: { code: dto.code },
      select: { id: true },
    });
    if (clash) throw new AlreadyExistsError('price list', 'code', dto.code);

    const created = await this.prisma.transaction(async (tx) => {
      const clone = await tx.priceList.create({
        data: {
          code: dto.code,
          name: dto.name,
          status: 'DRAFT',
          currency: source.currency,
          priceBasis: source.priceBasis,
          validFrom: new Date(`${dto.validFrom}T00:00:00.000Z`),
          validTo: dto.validTo ? new Date(`${dto.validTo}T00:00:00.000Z`) : null,
          isDefault: false,
          version: source.version + 1,
          clonedFromId: source.id,
          createdById: actorId,
        },
        select: PRICE_LIST_SELECT,
      });

      const sourceItems = await tx.priceListItem.findMany({
        where: { priceListId: id },
        select: { productId: true, variantId: true, minQty: true, price: true, minPrice: true },
      });

      if (sourceItems.length > 0) {
        const factor = dto.adjustPercent ? Money.of('100').add(dto.adjustPercent) : null;

        await tx.priceListItem.createMany({
          data: sourceItems.map((item) => {
            const price = factor
              ? Money.of(item.price.toFixed(4)).multiply(factor.toString()).divide(100).round(4)
              : Money.of(item.price.toFixed(4));
            const minPrice = item.minPrice
              ? factor
                ? Money.of(item.minPrice.toFixed(4)).multiply(factor.toString()).divide(100).round(4)
                : Money.of(item.minPrice.toFixed(4))
              : null;

            return {
              priceListId: clone.id,
              productId: item.productId,
              variantId: item.variantId,
              minQty: item.minQty,
              price: price.toString(),
              minPrice: minPrice ? minPrice.toString() : null,
            };
          }),
        });
      }

      await this.audit.record(tx, {
        action: 'pricelist.cloned',
        entityType: 'PriceList',
        entityId: clone.id,
        after: {
          from: source.code,
          to: dto.code,
          items: sourceItems.length,
          adjustPercent: dto.adjustPercent ?? null,
        },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.PRICE_LIST_CLONED,
        { type: 'PriceList', id: clone.id },
        { from: source.code, to: dto.code, items: String(sourceItems.length) },
      );

      return clone;
    });

    this.logger.info(
      { priceListId: created.id, code: created.code, from: source.code },
      'Price list cloned',
    );
    return toSummary(created);
  }

  /**
   * DRAFT → ACTIVE.
   *
   * Its own permission (`pricelist:publish`) because this is the moment prices
   * become real: whoever assembles a list should not necessarily be the person
   * who commits the company to it.
   */
  async publish(id: string, actorId: string) {
    const priceList = await this.prisma.db.priceList.findFirst({
      where: { id },
      select: { id: true, code: true, status: true, _count: { select: { items: true } } },
    });
    if (!priceList) throw new NotFoundError('PriceList', id);

    if (!canTransitionPriceList(priceList.status, 'ACTIVE')) {
      throw new ConflictError(
        `Price list ${priceList.code} is ${priceList.status} and cannot be published.`,
      );
    }

    // An empty published list resolves to NO_PRICE on every quote, which reads
    // as a system fault rather than as "nobody entered the prices".
    if (priceList._count.items === 0) {
      throw new ConflictError(
        `Cannot publish ${priceList.code}: it has no prices in it. Add price points first.`,
      );
    }

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.priceList.update({
        where: { id },
        data: { status: 'ACTIVE', publishedAt: this.clock.now(), updatedById: actorId },
        select: PRICE_LIST_SELECT,
      });

      await this.audit.record(tx, {
        // Publishing changes what every assigned partner pays.
        category: 'SECURITY',
        action: 'pricelist.published',
        entityType: 'PriceList',
        entityId: id,
        before: { status: priceList.status },
        after: { status: 'ACTIVE', itemCount: priceList._count.items },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.PRICE_LIST_PUBLISHED,
        { type: 'PriceList', id },
        { code: priceList.code, itemCount: String(priceList._count.items) },
      );

      return result;
    });

    this.logger.warn({ priceListId: id, code: priceList.code, actorId }, 'Price list published');
    return toSummary(updated);
  }

  async archive(id: string, actorId: string) {
    const priceList = await this.prisma.db.priceList.findFirst({
      where: { id },
      select: {
        id: true,
        code: true,
        status: true,
        isDefault: true,
        _count: { select: { distributors: true } },
      },
    });
    if (!priceList) throw new NotFoundError('PriceList', id);

    if (!canTransitionPriceList(priceList.status, 'ARCHIVED')) {
      throw new ConflictError(`Price list ${priceList.code} is already archived.`);
    }
    if (priceList.isDefault) {
      throw new ConflictError(
        `${priceList.code} is the default price list. Make another list the default before archiving it.`,
      );
    }
    if (priceList._count.distributors > 0) {
      throw new ConflictError(
        `${priceList._count.distributors} distributor(s) are still assigned to ${priceList.code}. ` +
          'Reassign them first — archiving would leave them quoting from an expired list.',
      );
    }

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.priceList.update({
        where: { id },
        data: { status: 'ARCHIVED', updatedById: actorId },
        select: PRICE_LIST_SELECT,
      });

      await this.audit.record(tx, {
        action: 'pricelist.archived',
        entityType: 'PriceList',
        entityId: id,
        before: { status: priceList.status },
        after: { status: 'ARCHIVED' },
      });

      return result;
    });

    return toSummary(updated);
  }

  /**
   * Exactly one default list.
   *
   * The partial unique index in migration 0006 makes two defaults impossible;
   * demoting here is what stops that constraint from surfacing as a raw
   * database error to the user.
   */
  private async demoteExistingDefault(
    tx: PrismaTransaction,
    exceptId: string | null,
  ): Promise<void> {
    await tx.priceList.updateMany({
      where: { isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
      data: { isDefault: false },
    });
  }
}

function toSummary(row: PriceListRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    currency: row.currency,
    priceBasis: row.priceBasis,
    validFrom: row.validFrom.toISOString().slice(0, 10),
    validTo: row.validTo ? row.validTo.toISOString().slice(0, 10) : null,
    isDefault: row.isDefault,
    version: row.version,
    clonedFromId: row.clonedFromId,
    itemCount: row._count.items,
    distributorCount: row._count.distributors,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
  };
}
