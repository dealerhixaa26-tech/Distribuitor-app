import { Injectable } from '@nestjs/common';
import { DOMAIN_EVENTS, type AuthorizeProductDto } from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ConflictError, NotFoundError } from '../../common/errors/domain.error';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';

/**
 * The authorized catalog — which products a distributor may buy.
 *
 * Closes the second seam Phase 5 left open (docs/16 §Seams, docs/17 §1).
 *
 * ── The security-relevant part ────────────────────────────────────────────
 * `DistributorProduct` is registered in SCOPE_REGISTRY as `viaDistributor()`,
 * so every read here is already bounded by the caller's territory. That covers
 * reads. WRITES need their own guard, because `create` takes a distributorId
 * from the request body and Prisma has nothing to filter on an insert — a
 * territory-scoped caller could otherwise author rows against a distributor
 * they cannot see.
 *
 * `assertDistributorVisible` is that guard: it re-reads the distributor through
 * the SCOPED client, so an out-of-scope id comes back empty and becomes a 404.
 * HANDOFF §4.4 — a control is not verified until something is refused; this one
 * is exercised in `distributor-catalog.scope.spec.ts` and by the curl transcript
 * in docs/18.
 */
@Injectable()
export class DistributorCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DistributorCatalogService.name);
  }

  /**
   * Confirms the distributor is visible to THIS caller.
   *
   * Reads through `prisma.db`, the scoped client. For a territory-scoped user
   * a distributor outside their subtree simply does not exist, and the 404 that
   * results is deliberate: a 403 would confirm the record exists and turn the
   * endpoint into an enumeration oracle.
   */
  private async assertDistributorVisible(
    distributorId: string,
  ): Promise<{ id: string; code: string }> {
    const distributor = await this.prisma.db.distributor.findFirst({
      where: { id: distributorId },
      select: { id: true, code: true },
    });
    if (!distributor) throw new NotFoundError('Distributor', distributorId);
    return distributor;
  }

  async list(distributorId: string, query: { q?: string; isActive?: boolean }) {
    await this.assertDistributorVisible(distributorId);

    const where: Prisma.DistributorProductWhereInput = {
      distributorId,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.q
        ? {
            product: {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { sku: { contains: query.q.toUpperCase() } },
              ],
            },
          }
        : {}),
    };

    const rows = await this.prisma.db.distributorProduct.findMany({
      where,
      orderBy: { product: { sku: 'asc' } },
      select: AUTHORIZED_SELECT,
    });

    return { data: rows.map(toSummary) };
  }

  async authorize(distributorId: string, dto: AuthorizeProductDto, actorId: string) {
    const distributor = await this.assertDistributorVisible(distributorId);

    const product = await this.prisma.db.product.findFirst({
      where: { id: dto.productId },
      select: { id: true, sku: true, name: true, status: true },
    });
    if (!product) throw new NotFoundError('Product', dto.productId);

    if (product.status === 'ARCHIVED') {
      throw new ConflictError(
        `${product.sku} is archived and cannot be added to an authorized catalog.`,
      );
    }

    if (dto.customPriceListId) {
      const priceList = await this.prisma.db.priceList.findFirst({
        where: { id: dto.customPriceListId },
        select: { id: true, status: true, code: true },
      });
      if (!priceList) throw new NotFoundError('PriceList', dto.customPriceListId);
      if (priceList.status !== 'ACTIVE') {
        throw new ConflictError(
          `Price list ${priceList.code} is ${priceList.status}; only an ACTIVE list can be assigned.`,
        );
      }
    }

    const existing = await this.prisma.db.distributorProduct.findFirst({
      where: { distributorId, productId: dto.productId },
      select: { id: true, isActive: true },
    });

    return this.prisma.transaction(async (tx) => {
      const row = existing
        ? await tx.distributorProduct.update({
            where: { id: existing.id },
            data: {
              isActive: true,
              customPriceListId: dto.customPriceListId ?? null,
              maxOrderQty: dto.maxOrderQty ?? null,
              notes: dto.notes ?? null,
            },
            select: AUTHORIZED_SELECT,
          })
        : await tx.distributorProduct.create({
            data: {
              distributorId,
              productId: dto.productId,
              customPriceListId: dto.customPriceListId ?? null,
              maxOrderQty: dto.maxOrderQty ?? null,
              notes: dto.notes ?? null,
              createdById: actorId,
            },
            select: AUTHORIZED_SELECT,
          });

      await this.audit.record(tx, {
        // What a partner may buy, and at what price, is a commercial control.
        category: 'SECURITY',
        action: 'distributor.product_authorized',
        entityType: 'Distributor',
        entityId: distributorId,
        after: {
          sku: product.sku,
          customPriceListId: dto.customPriceListId ?? null,
          maxOrderQty: dto.maxOrderQty ?? null,
        },
        metadata: { actorId },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.DISTRIBUTOR_CATALOG_CHANGED,
        { type: 'Distributor', id: distributorId },
        { code: distributor.code, sku: product.sku, action: 'authorized' },
      );

      return toSummary(row);
    });
  }

  /** Adds many products at once — onboarding a partner onto a whole range. */
  async authorizeMany(
    distributorId: string,
    productIds: readonly string[],
    customPriceListId: string | undefined,
    actorId: string,
  ) {
    const distributor = await this.assertDistributorVisible(distributorId);

    const products = await this.prisma.db.product.findMany({
      where: { id: { in: [...productIds] }, status: { not: 'ARCHIVED' } },
      select: { id: true, sku: true },
    });

    if (products.length !== productIds.length) {
      const known = new Set(products.map((product) => product.id));
      const missing = productIds.filter((id) => !known.has(id));
      throw new NotFoundError('Product (or archived)', missing.join(', '));
    }

    return this.prisma.transaction(async (tx) => {
      // `skipDuplicates` keeps this idempotent: re-running an onboarding script
      // must not fail on the products already authorized.
      const created = await tx.distributorProduct.createMany({
        data: products.map((product) => ({
          distributorId,
          productId: product.id,
          customPriceListId: customPriceListId ?? null,
          createdById: actorId,
        })),
        skipDuplicates: true,
      });

      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'distributor.products_bulk_authorized',
        entityType: 'Distributor',
        entityId: distributorId,
        after: { requested: productIds.length, added: created.count },
        metadata: { actorId },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.DISTRIBUTOR_CATALOG_CHANGED,
        { type: 'Distributor', id: distributorId },
        { code: distributor.code, added: String(created.count), action: 'bulk_authorized' },
      );

      return { requested: productIds.length, added: created.count };
    });
  }

  async revoke(distributorId: string, productId: string, actorId: string): Promise<void> {
    await this.assertDistributorVisible(distributorId);

    const row = await this.prisma.db.distributorProduct.findFirst({
      where: { distributorId, productId },
      select: { id: true, product: { select: { sku: true } } },
    });
    if (!row) throw new NotFoundError('Authorized product', productId);

    await this.prisma.transaction(async (tx) => {
      await tx.distributorProduct.softDelete({ id: row.id });

      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'distributor.product_revoked',
        entityType: 'Distributor',
        entityId: distributorId,
        before: { sku: row.product.sku },
        metadata: { actorId },
      });
    });

    this.logger.info(
      { distributorId, productId, sku: row.product.sku, actorId },
      'Product authorization revoked',
    );
  }
}

const AUTHORIZED_SELECT = {
  id: true,
  productId: true,
  customPriceListId: true,
  isActive: true,
  maxOrderQty: true,
  notes: true,
  authorizedAt: true,
  createdAt: true,
  product: {
    select: { sku: true, name: true, type: true, status: true, hsnCode: true, sacCode: true },
  },
  customPriceList: { select: { code: true, name: true } },
} satisfies Prisma.DistributorProductSelect;

type AuthorizedRow = Prisma.DistributorProductGetPayload<{ select: typeof AUTHORIZED_SELECT }>;

function toSummary(row: AuthorizedRow) {
  return {
    id: row.id,
    productId: row.productId,
    sku: row.product.sku,
    name: row.product.name,
    type: row.product.type,
    productStatus: row.product.status,
    hsnSacCode: row.product.sacCode ?? row.product.hsnCode,
    customPriceListId: row.customPriceListId,
    customPriceListCode: row.customPriceList?.code ?? null,
    isActive: row.isActive,
    maxOrderQty: row.maxOrderQty ? row.maxOrderQty.toFixed(4) : null,
    notes: row.notes,
    authorizedAt: row.authorizedAt,
    createdAt: row.createdAt,
  };
}
