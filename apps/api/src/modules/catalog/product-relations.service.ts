import { Injectable } from '@nestjs/common';
import {
  MAX_BOM_DEPTH,
  Money,
  type AddBomComponentDto,
  type AttachProductMediaDto,
  type BomExplosionLine,
  type ProductSpecificationDto,
} from '@hixaa/contracts';
import { PinoLogger } from 'nestjs-pino';
import { ConflictError, NotFoundError } from '../../common/errors/domain.error';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/**
 * Specifications, media, and the bill of materials.
 *
 * Split from `ProductsService` so that class stays about the product's own
 * identity and lifecycle. These are satellites: they describe a product
 * without changing what it is.
 */
@Injectable()
export class ProductRelationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProductRelationsService.name);
  }

  private async assertProductExists(productId: string): Promise<{ id: string; sku: string }> {
    const product = await this.prisma.db.product.findFirst({
      where: { id: productId },
      select: { id: true, sku: true },
    });
    if (!product) throw new NotFoundError('Product', productId);
    return product;
  }

  // ── Specifications ────────────────────────────────────────────────────────

  async addSpecification(productId: string, dto: ProductSpecificationDto, actorId: string) {
    await this.assertProductExists(productId);

    return this.prisma.transaction(async (tx) => {
      const spec = await tx.productSpecification.create({
        data: {
          productId,
          groupName: dto.groupName ?? null,
          name: dto.name,
          value: dto.value,
          unit: dto.unit ?? null,
          sortOrder: dto.sortOrder,
        },
        select: { id: true, groupName: true, name: true, value: true, unit: true, sortOrder: true },
      });

      await this.audit.record(tx, {
        action: 'product.specification_added',
        entityType: 'Product',
        entityId: productId,
        after: { name: dto.name, value: dto.value, unit: dto.unit ?? null },
        metadata: { actorId, specificationId: spec.id },
      });

      return spec;
    });
  }

  /** Replaces the whole specification sheet in one transaction. */
  async replaceSpecifications(
    productId: string,
    specs: readonly ProductSpecificationDto[],
    actorId: string,
  ) {
    await this.assertProductExists(productId);

    return this.prisma.transaction(async (tx) => {
      // ProductSpecification has no `deletedAt`, so it is not soft-deletable
      // and `deleteMany` is the correct operation here rather than an error.
      await tx.productSpecification.deleteMany({ where: { productId } });

      if (specs.length > 0) {
        await tx.productSpecification.createMany({
          data: specs.map((spec) => ({
            productId,
            groupName: spec.groupName ?? null,
            name: spec.name,
            value: spec.value,
            unit: spec.unit ?? null,
            sortOrder: spec.sortOrder,
          })),
        });
      }

      await this.audit.record(tx, {
        action: 'product.specifications_replaced',
        entityType: 'Product',
        entityId: productId,
        after: { count: specs.length },
        metadata: { actorId },
      });

      return tx.productSpecification.findMany({
        where: { productId },
        orderBy: [{ groupName: 'asc' }, { sortOrder: 'asc' }],
        select: { id: true, groupName: true, name: true, value: true, unit: true, sortOrder: true },
      });
    });
  }

  async removeSpecification(productId: string, specificationId: string, actorId: string) {
    const spec = await this.prisma.db.productSpecification.findFirst({
      where: { id: specificationId, productId },
      select: { id: true, name: true },
    });
    if (!spec) throw new NotFoundError('Specification', specificationId);

    await this.prisma.transaction(async (tx) => {
      await tx.productSpecification.delete({ where: { id: specificationId } });
      await this.audit.record(tx, {
        action: 'product.specification_removed',
        entityType: 'Product',
        entityId: productId,
        before: { name: spec.name },
        metadata: { actorId },
      });
    });
  }

  // ── Media ─────────────────────────────────────────────────────────────────

  /**
   * Links an already-uploaded document to a product.
   *
   * Takes a `documentId` rather than a file: DocumentsService owns upload,
   * virus scanning, and storage, and duplicating any of that here would create
   * a second path by which an unscanned file could reach a user.
   */
  async attachMedia(productId: string, dto: AttachProductMediaDto, actorId: string) {
    await this.assertProductExists(productId);

    const document = await this.prisma.db.document.findFirst({
      where: { id: dto.documentId },
      select: { id: true, originalName: true, scanStatus: true },
    });
    if (!document) throw new NotFoundError('Document', dto.documentId);

    if (document.scanStatus === 'INFECTED') {
      throw new ConflictError(
        'That document failed its virus scan and cannot be attached to a product.',
      );
    }

    return this.prisma.transaction(async (tx) => {
      // Exactly one primary image: demote any existing one rather than ending
      // up with two and no way to say which the catalog should show.
      if (dto.isPrimary) {
        await tx.productMedia.updateMany({
          where: { productId, type: dto.type, isPrimary: true },
          data: { isPrimary: false },
        });
      }

      const media = await tx.productMedia.create({
        data: {
          productId,
          documentId: dto.documentId,
          type: dto.type,
          title: dto.title ?? null,
          isPrimary: dto.isPrimary,
          sortOrder: dto.sortOrder,
        },
        select: { id: true, type: true, title: true, isPrimary: true, documentId: true },
      });

      await this.audit.record(tx, {
        action: 'product.media_attached',
        entityType: 'Product',
        entityId: productId,
        after: { type: dto.type, documentId: dto.documentId, name: document.originalName },
        metadata: { actorId },
      });

      return media;
    });
  }

  async removeMedia(productId: string, mediaId: string, actorId: string): Promise<void> {
    const media = await this.prisma.db.productMedia.findFirst({
      where: { id: mediaId, productId },
      select: { id: true, type: true },
    });
    if (!media) throw new NotFoundError('Product media', mediaId);

    await this.prisma.transaction(async (tx) => {
      await tx.productMedia.delete({ where: { id: mediaId } });
      await this.audit.record(tx, {
        action: 'product.media_removed',
        entityType: 'Product',
        entityId: productId,
        before: { type: media.type },
        metadata: { actorId },
      });
    });
  }

  // ── Bill of materials ─────────────────────────────────────────────────────

  async addBomComponent(parentId: string, dto: AddBomComponentDto, actorId: string) {
    const parent = await this.assertProductExists(parentId);

    if (dto.componentProductId === parentId) {
      throw new ConflictError('A product cannot be a component of itself.');
    }

    const component = await this.prisma.db.product.findFirst({
      where: { id: dto.componentProductId },
      select: { id: true, sku: true, name: true, type: true, status: true },
    });
    if (!component) throw new NotFoundError('Component product', dto.componentProductId);

    // The database CHECK catches a direct self-reference; only a full graph
    // walk can catch A → B → A, and this is the only place with that view.
    await this.assertNoCycle(parentId, dto.componentProductId);

    const existing = await this.prisma.db.productBom.findFirst({
      where: { parentProductId: parentId, componentProductId: dto.componentProductId },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError(
        `${component.sku} is already a component of ${parent.sku}. Change its quantity instead of adding it twice.`,
      );
    }

    return this.prisma.transaction(async (tx) => {
      const entry = await tx.productBom.create({
        data: {
          parentProductId: parentId,
          componentProductId: dto.componentProductId,
          quantity: dto.quantity,
          isOptional: dto.isOptional,
          sortOrder: dto.sortOrder,
          notes: dto.notes ?? null,
        },
        select: { id: true, quantity: true, isOptional: true, sortOrder: true, notes: true },
      });

      await this.audit.record(tx, {
        action: 'product.bom_component_added',
        entityType: 'Product',
        entityId: parentId,
        after: { component: component.sku, quantity: dto.quantity, isOptional: dto.isOptional },
        metadata: { actorId },
      });

      return { ...entry, quantity: entry.quantity.toFixed(4), component };
    });
  }

  async removeBomComponent(parentId: string, componentId: string, actorId: string): Promise<void> {
    const entry = await this.prisma.db.productBom.findFirst({
      where: { parentProductId: parentId, componentProductId: componentId },
      select: { id: true, component: { select: { sku: true } } },
    });
    if (!entry) throw new NotFoundError('BOM component', componentId);

    await this.prisma.transaction(async (tx) => {
      await tx.productBom.delete({ where: { id: entry.id } });
      await this.audit.record(tx, {
        action: 'product.bom_component_removed',
        entityType: 'Product',
        entityId: parentId,
        before: { component: entry.component.sku },
        metadata: { actorId },
      });
    });
  }

  /**
   * Explodes a kit into its leaf components.
   *
   * This is what makes "Raksha IoT — 50-Worker Deployment" one sellable line
   * that resolves into gateways, wearable tags, a server licence, and
   * commissioning. Phase 6 reserves stock against the explosion; Phase 7
   * prices it.
   *
   * Depth-limited and cycle-guarded. A BOM cycle is not merely a bad answer —
   * an unguarded walk either loops forever or silently truncates, and both
   * fail in ways that look like a stock bug rather than a data bug.
   */
  async explode(productId: string, quantity = '1'): Promise<BomExplosionLine[]> {
    await this.assertProductExists(productId);

    const lines: BomExplosionLine[] = [];

    const walk = async (
      parentId: string,
      multiplier: Money,
      depth: number,
      ancestry: readonly string[],
    ): Promise<void> => {
      if (depth > MAX_BOM_DEPTH) {
        throw new ConflictError(
          `Bill of materials nests deeper than ${MAX_BOM_DEPTH} levels, which usually means a cycle. ` +
            `Chain: ${ancestry.join(' → ')}`,
        );
      }

      const components = await this.prisma.db.productBom.findMany({
        where: { parentProductId: parentId },
        orderBy: { sortOrder: 'asc' },
        select: {
          quantity: true,
          isOptional: true,
          component: {
            select: { id: true, sku: true, name: true, type: true },
          },
        },
      });

      for (const entry of components) {
        if (ancestry.includes(entry.component.id)) {
          throw new ConflictError(
            `Bill of materials contains a cycle: ${[...ancestry, entry.component.sku].join(' → ')}`,
          );
        }

        const perParent = multiplier.multiply(entry.quantity.toFixed(4));
        const nextAncestry = [...ancestry, entry.component.id];

        lines.push({
          productId: entry.component.id,
          sku: entry.component.sku,
          name: entry.component.name,
          type: entry.component.type,
          quantityPerParent: perParent.toString(),
          totalQuantity: perParent.multiply(quantity).toString(),
          isOptional: entry.isOptional,
          depth,
          path: nextAncestry,
        });

        await walk(entry.component.id, perParent, depth + 1, nextAncestry);
      }
    };

    await walk(productId, Money.of('1'), 1, [productId]);
    return lines;
  }

  /**
   * Refuses an edge that would close a loop.
   *
   * Walks UP from the proposed component: if the parent is reachable from it,
   * adding this edge makes the parent its own ancestor.
   */
  private async assertNoCycle(parentId: string, componentId: string): Promise<void> {
    const visited = new Set<string>();
    let frontier = [componentId];

    for (let depth = 0; depth < MAX_BOM_DEPTH && frontier.length > 0; depth++) {
      const rows = await this.prisma.db.productBom.findMany({
        where: { parentProductId: { in: frontier } },
        select: { componentProductId: true },
      });

      const next: string[] = [];
      for (const row of rows) {
        if (row.componentProductId === parentId) {
          throw new ConflictError(
            'That component already contains this product further down its own bill of materials — ' +
              'adding it here would create a cycle.',
          );
        }
        if (!visited.has(row.componentProductId)) {
          visited.add(row.componentProductId);
          next.push(row.componentProductId);
        }
      }
      frontier = next;
    }
  }
}
