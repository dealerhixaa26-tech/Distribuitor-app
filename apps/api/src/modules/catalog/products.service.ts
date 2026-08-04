import { Injectable } from '@nestjs/common';
import {
  DOMAIN_EVENTS,
  canTransitionProduct,
  type CreateProductDto,
  type ListProductsQuery,
  type UpdateProductDto,
} from '@hixaa/contracts';
import { Prisma, type ProductStatus } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import {
  AlreadyExistsError,
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
} from '../../common/errors/domain.error';
import { keysetWhere, parseSort, toListResult } from '../../common/utils/pagination.util';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';

/**
 * Products — the centre of the catalog.
 *
 * Two things here are load-bearing beyond ordinary CRUD:
 *
 *   • **Revisions.** Any change to a commercially significant field appends a
 *     `ProductRevision` snapshot and bumps `revision`. A quotation issued
 *     against revision 3 must stay explicable after revision 4 lands, and
 *     "what did this product look like when we quoted it?" is a question the
 *     audit log answers awkwardly and this answers directly.
 *
 *   • **Tax classification.** HSN for goods, SAC for services, exactly one.
 *     Checked here as well as in the Zod contract and as a CHECK constraint,
 *     because an internal caller bypasses the first and a psql session bypasses
 *     both.
 */

const SORTABLE = ['createdAt', 'name', 'sku'] as const;

/**
 * How many products a full-text search will consider.
 *
 * Search results are relevance-ranked, which is incompatible with the keyset
 * cursor used everywhere else, so a searched list returns one ranked page and
 * says so rather than paginating. At Hixaa's catalog size this is invisible;
 * it is documented rather than silent because a cap that nobody knows about
 * reads as "we searched everything" when it did not. See docs/17 §5.
 */
const SEARCH_RESULT_CAP = 200;

/** Fields whose change is commercially significant enough to cut a revision. */
const REVISION_TRIGGERING_FIELDS = [
  'name',
  'type',
  'hsnCode',
  'sacCode',
  'gstRate',
  'warrantyMonths',
  'minOrderQty',
  'isSerialized',
  'isBatchTracked',
] as const;

const PRODUCT_SELECT = {
  id: true,
  sku: true,
  name: true,
  slug: true,
  type: true,
  status: true,
  categoryId: true,
  brandId: true,
  hsnCode: true,
  sacCode: true,
  gstRate: true,
  isSerialized: true,
  isBatchTracked: true,
  warrantyMonths: true,
  leadTimeDays: true,
  minOrderQty: true,
  tags: true,
  revision: true,
  createdAt: true,
  category: { select: { name: true } },
  brand: { select: { name: true } },
  uom: { select: { code: true } },
  _count: { select: { specifications: true, bomComponents: true } },
} satisfies Prisma.ProductSelect;

type ProductRow = Prisma.ProductGetPayload<{ select: typeof PRODUCT_SELECT }>;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProductsService.name);
  }

  async list(query: ListProductsQuery) {
    const where = await this.buildWhere(query);

    // Search takes the ranked path; everything else takes the keyset path.
    if (query.q) {
      const ranked = await this.searchIds(query.q);
      if (ranked.length === 0) {
        return { data: [], meta: { cursor: { next: null, hasMore: false }, totalCount: 0 } };
      }

      const rows = await this.prisma.db.product.findMany({
        where: { AND: [where, { id: { in: ranked } }] },
        select: PRODUCT_SELECT,
      });

      // Re-impose relevance order: `IN` returns rows in physical order, and
      // the whole point of ranking is lost if we hand back arbitrary order.
      const rank = new Map(ranked.map((id, index) => [id, index]));
      rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));

      const page = rows.slice(0, query.limit);
      return {
        data: page.map(toSummary),
        meta: {
          cursor: { next: null, hasMore: rows.length > query.limit },
          totalCount: rows.length,
          // Stated explicitly so a caller can tell a truncated search from an
          // exhaustive one.
          truncated: ranked.length >= SEARCH_RESULT_CAP,
        },
      };
    }

    const cursorWhere = keysetWhere(query.cursor);
    const rows = await this.prisma.db.product.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: parseSort(query.sort, SORTABLE),
      take: query.limit + 1,
      select: PRODUCT_SELECT,
    });

    const totalCount = query.includeTotal
      ? await this.prisma.db.product.count({ where })
      : undefined;

    const result = toListResult(rows, query.limit, totalCount);
    return { ...result, data: result.data.map(toSummary) };
  }

  async findById(id: string) {
    const product = await this.prisma.db.product.findFirst({
      where: { id },
      select: PRODUCT_SELECT,
    });
    if (!product) throw new NotFoundError('Product', id);
    return toSummary(product);
  }

  /** Everything the product detail screen needs, in one round trip. */
  async findDetail(id: string) {
    const summary = await this.findById(id);

    const [specifications, media, bom, variants, prices] = await Promise.all([
      this.prisma.db.productSpecification.findMany({
        where: { productId: id },
        orderBy: [{ groupName: 'asc' }, { sortOrder: 'asc' }],
        select: { id: true, groupName: true, name: true, value: true, unit: true, sortOrder: true },
      }),
      this.prisma.db.productMedia.findMany({
        where: { productId: id },
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
        select: {
          id: true,
          type: true,
          title: true,
          isPrimary: true,
          documentId: true,
          document: { select: { originalName: true, mimeType: true, sizeBytes: true, scanStatus: true } },
        },
      }),
      this.prisma.db.productBom.findMany({
        where: { parentProductId: id },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          quantity: true,
          isOptional: true,
          notes: true,
          component: { select: { id: true, sku: true, name: true, type: true, status: true } },
        },
      }),
      this.prisma.db.productVariant.findMany({
        where: { productId: id, isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, sku: true, name: true, attributes: true },
      }),
      this.prisma.db.priceListItem.findMany({
        where: { productId: id },
        orderBy: [{ priceList: { code: 'asc' } }, { minQty: 'asc' }],
        select: {
          id: true,
          minQty: true,
          price: true,
          minPrice: true,
          variantId: true,
          priceList: { select: { id: true, code: true, name: true, status: true } },
        },
      }),
    ]);

    return {
      ...summary,
      specifications,
      media: media.map((item) => ({
        ...item,
        document: item.document
          ? { ...item.document, sizeBytes: Number(item.document.sizeBytes) }
          : null,
      })),
      bom: bom.map((entry) => ({
        id: entry.id,
        quantity: entry.quantity.toFixed(4),
        isOptional: entry.isOptional,
        notes: entry.notes,
        component: entry.component,
      })),
      variants,
      prices: prices.map((price) => ({
        id: price.id,
        priceListId: price.priceList.id,
        priceListCode: price.priceList.code,
        priceListName: price.priceList.name,
        priceListStatus: price.priceList.status,
        variantId: price.variantId,
        minQty: price.minQty.toFixed(4),
        price: price.price.toFixed(4),
        minPrice: price.minPrice ? price.minPrice.toFixed(4) : null,
      })),
    };
  }

  async create(dto: CreateProductDto, actorId: string) {
    this.assertTaxClassification(dto.type, dto.hsnCode, dto.sacCode);

    const existing = await this.prisma.db.product.findFirst({
      where: { sku: dto.sku },
      select: { id: true },
    });
    if (existing) throw new AlreadyExistsError('product', 'sku', dto.sku);

    const created = await this.prisma.transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          sku: dto.sku,
          name: dto.name,
          slug: dto.slug ?? slugify(dto.name),
          type: dto.type,
          // Always starts as DRAFT. Creating something already ACTIVE would
          // let a product reach a quotation before anyone reviewed its tax
          // classification or its price.
          status: 'DRAFT',
          categoryId: dto.categoryId ?? null,
          brandId: dto.brandId ?? null,
          uomId: dto.uomId ?? null,
          shortDescription: dto.shortDescription ?? null,
          description: dto.description ?? null,
          hsnCode: dto.hsnCode ?? null,
          sacCode: dto.sacCode ?? null,
          gstRate: dto.gstRate,
          isSerialized: dto.isSerialized,
          isBatchTracked: dto.isBatchTracked,
          isReturnable: dto.isReturnable,
          isPurchasable: dto.isPurchasable,
          isSellable: dto.isSellable,
          warrantyMonths: dto.warrantyMonths ?? null,
          leadTimeDays: dto.leadTimeDays ?? null,
          minOrderQty: dto.minOrderQty,
          weightGrams: dto.weightGrams ?? null,
          tags: dto.tags,
          createdById: actorId,
          ...(dto.specifications.length
            ? { specifications: { createMany: { data: dto.specifications } } }
            : {}),
        },
        select: PRODUCT_SELECT,
      });

      await this.audit.record(tx, {
        action: 'product.created',
        entityType: 'Product',
        entityId: product.id,
        after: { sku: dto.sku, name: dto.name, type: dto.type, status: 'DRAFT' },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.PRODUCT_CREATED,
        { type: 'Product', id: product.id },
        { sku: dto.sku, name: dto.name },
      );

      return product;
    });

    this.logger.info({ productId: created.id, sku: created.sku }, 'Product created');
    return toSummary(created);
  }

  async update(id: string, dto: UpdateProductDto, actorId: string) {
    const before = await this.prisma.db.product.findFirst({
      where: { id },
      select: {
        id: true,
        sku: true,
        name: true,
        type: true,
        status: true,
        revision: true,
        categoryId: true,
        brandId: true,
        hsnCode: true,
        sacCode: true,
        gstRate: true,
        warrantyMonths: true,
        leadTimeDays: true,
        minOrderQty: true,
        isSerialized: true,
        isBatchTracked: true,
        tags: true,
      },
    });
    if (!before) throw new NotFoundError('Product', id);

    this.assertTaxClassification(
      dto.type ?? before.type,
      dto.hsnCode !== undefined ? dto.hsnCode : (before.hsnCode ?? undefined),
      dto.sacCode !== undefined ? dto.sacCode : (before.sacCode ?? undefined),
    );

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.product.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
          ...(dto.brandId !== undefined ? { brandId: dto.brandId } : {}),
          ...(dto.uomId !== undefined ? { uomId: dto.uomId } : {}),
          ...(dto.shortDescription !== undefined ? { shortDescription: dto.shortDescription } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.hsnCode !== undefined ? { hsnCode: dto.hsnCode } : {}),
          ...(dto.sacCode !== undefined ? { sacCode: dto.sacCode } : {}),
          ...(dto.gstRate !== undefined ? { gstRate: dto.gstRate } : {}),
          ...(dto.isSerialized !== undefined ? { isSerialized: dto.isSerialized } : {}),
          ...(dto.isBatchTracked !== undefined ? { isBatchTracked: dto.isBatchTracked } : {}),
          ...(dto.isReturnable !== undefined ? { isReturnable: dto.isReturnable } : {}),
          ...(dto.isPurchasable !== undefined ? { isPurchasable: dto.isPurchasable } : {}),
          ...(dto.isSellable !== undefined ? { isSellable: dto.isSellable } : {}),
          ...(dto.warrantyMonths !== undefined ? { warrantyMonths: dto.warrantyMonths } : {}),
          ...(dto.leadTimeDays !== undefined ? { leadTimeDays: dto.leadTimeDays } : {}),
          ...(dto.minOrderQty !== undefined ? { minOrderQty: dto.minOrderQty } : {}),
          ...(dto.weightGrams !== undefined ? { weightGrams: dto.weightGrams } : {}),
          ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
          updatedById: actorId,
        },
        select: PRODUCT_SELECT,
      });

      const diff = AuditService.diff(
        {
          name: before.name,
          type: before.type,
          hsnCode: before.hsnCode,
          sacCode: before.sacCode,
          gstRate: before.gstRate.toFixed(2),
          warrantyMonths: before.warrantyMonths,
          leadTimeDays: before.leadTimeDays,
          minOrderQty: before.minOrderQty.toFixed(4),
          isSerialized: before.isSerialized,
          isBatchTracked: before.isBatchTracked,
          tags: before.tags,
        },
        {
          name: result.name,
          type: result.type,
          hsnCode: result.hsnCode,
          sacCode: result.sacCode,
          gstRate: result.gstRate.toFixed(2),
          warrantyMonths: result.warrantyMonths,
          leadTimeDays: result.leadTimeDays,
          minOrderQty: result.minOrderQty.toFixed(4),
          isSerialized: result.isSerialized,
          isBatchTracked: result.isBatchTracked,
          tags: result.tags,
        },
      );

      if (diff.changed.length === 0) return result;

      await this.audit.record(tx, {
        action: 'product.updated',
        entityType: 'Product',
        entityId: id,
        before: diff.before,
        after: diff.after,
      });

      // A commercially significant change cuts a revision, so a quotation
      // raised earlier can still be explained against what the product was.
      const significant = diff.changed.filter((field) =>
        (REVISION_TRIGGERING_FIELDS as readonly string[]).includes(field),
      );

      if (significant.length > 0) {
        await tx.productRevision.create({
          data: {
            productId: id,
            revision: before.revision,
            snapshot: diff.before as Prisma.InputJsonValue,
            changedBy: actorId,
            reason: `Changed: ${significant.join(', ')}`,
          },
        });
        await tx.product.update({
          where: { id },
          data: { revision: { increment: 1 } },
        });

        await this.outbox.emit(
          tx,
          DOMAIN_EVENTS.PRODUCT_PRICE_AFFECTING_CHANGE,
          { type: 'Product', id },
          { sku: before.sku, fields: significant.join(', '), revision: before.revision },
        );
      }

      return result;
    });

    return toSummary(updated);
  }

  async changeStatus(id: string, to: ProductStatus, reason: string | undefined, actorId: string) {
    const product = await this.prisma.db.product.findFirst({
      where: { id },
      select: { id: true, sku: true, status: true, hsnCode: true, sacCode: true, type: true },
    });
    if (!product) throw new NotFoundError('Product', id);

    if (!canTransitionProduct(product.status, to)) {
      throw new InvalidStateTransitionError('product', product.status, to);
    }

    // Activation is the gate where the tax classification stops being optional:
    // once ACTIVE the product can reach a quotation, and from there an invoice.
    if (to === 'ACTIVE') {
      if (!product.hsnCode && !product.sacCode) {
        throw new ConflictError(
          `Cannot activate ${product.sku} without an HSN or SAC code — every invoice line needs one.`,
        );
      }
      this.assertTaxClassification(
        product.type,
        product.hsnCode ?? undefined,
        product.sacCode ?? undefined,
      );
    }

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.product.update({
        where: { id },
        data: { status: to, updatedById: actorId },
        select: PRODUCT_SELECT,
      });

      await this.audit.record(tx, {
        action: 'product.status_changed',
        entityType: 'Product',
        entityId: id,
        before: { status: product.status },
        after: { status: to },
        metadata: { reason },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.PRODUCT_STATUS_CHANGED,
        { type: 'Product', id },
        { sku: product.sku, from: product.status, to },
      );

      return result;
    });

    this.logger.info({ productId: id, sku: product.sku, from: product.status, to }, 'Product status changed');
    return toSummary(updated);
  }

  async remove(id: string, actorId: string): Promise<void> {
    const product = await this.prisma.db.product.findFirst({
      where: { id },
      select: {
        id: true,
        sku: true,
        _count: { select: { priceListItems: true, bomUsedIn: true, authorizedFor: true } },
      },
    });
    if (!product) throw new NotFoundError('Product', id);

    // Refused rather than cascaded: a product that is a component of a kit
    // would silently change what that kit explodes into.
    if (product._count.bomUsedIn > 0) {
      throw new ConflictError(
        `Cannot delete ${product.sku}: it is a component of ${product._count.bomUsedIn} other product(s). ` +
          'Archive it instead — archiving keeps history intact.',
      );
    }

    await this.prisma.transaction(async (tx) => {
      await tx.product.softDelete({ id });
      await this.audit.record(tx, {
        action: 'product.deleted',
        entityType: 'Product',
        entityId: id,
        before: { sku: product.sku },
        metadata: { actorId },
      });
    });
  }

  async revisions(id: string) {
    const product = await this.prisma.db.product.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!product) throw new NotFoundError('Product', id);

    return this.prisma.db.productRevision.findMany({
      where: { productId: id },
      orderBy: { revision: 'desc' },
      take: 50,
      select: { id: true, revision: true, snapshot: true, reason: true, changedBy: true, createdAt: true },
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async buildWhere(query: ListProductsQuery): Promise<Prisma.ProductWhereInput> {
    const where: Prisma.ProductWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.brandId ? { brandId: query.brandId } : {}),
      ...(query.isSerialized !== undefined ? { isSerialized: query.isSerialized } : {}),
      ...(query.hsnCode ? { hsnCode: query.hsnCode } : {}),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
    };

    if (query.status) {
      where.status = Array.isArray(query.status) ? { in: query.status } : query.status;
    }

    if (query.categoryId) {
      if (query.includeSubcategories) {
        const category = await this.prisma.db.category.findFirst({
          where: { id: query.categoryId },
          select: { path: true },
        });
        if (!category) throw new NotFoundError('Category', query.categoryId);
        where.category = { path: { startsWith: category.path } };
      } else {
        where.categoryId = query.categoryId;
      }
    }

    return where;
  }

  /**
   * Full-text search, relevance-ordered.
   *
   * Raw SQL because the `search_vector` column is Postgres-generated and
   * therefore invisible to Prisma. Raw queries also bypass the soft-delete
   * extension, so `deleted_at IS NULL` is applied explicitly here — the
   * extension cannot cover what it never sees.
   *
   * `websearch_to_tsquery` accepts what a person actually types ("raksha iot",
   * quoted phrases, `-excluded`) instead of requiring tsquery syntax. When it
   * matches nothing we fall back to trigram similarity, which catches the
   * typo case ("raksah" → "Raksha") the GIN trigram indexes exist for.
   */
  private async searchIds(term: string): Promise<string[]> {
    const exact = await this.prisma.db.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM product
      WHERE deleted_at IS NULL
        AND search_vector @@ websearch_to_tsquery('english', ${term})
      ORDER BY ts_rank(search_vector, websearch_to_tsquery('english', ${term})) DESC,
               created_at DESC
      LIMIT ${SEARCH_RESULT_CAP}
    `;
    if (exact.length > 0) return exact.map((row) => row.id);

    // `word_similarity`, not `similarity`, and not the `%` operator.
    //
    // `%` compares WHOLE strings against pg_trgm's 0.3 threshold. Measured
    // against real data: similarity('Raksha IoT Gateway', 'raksah') is 0.18 —
    // the long name dilutes the match, so `%` finds nothing and the fallback
    // silently never fires. word_similarity scores the query against the
    // closest word instead, giving 0.57 for the same pair.
    //
    // This is a sequential scan rather than an index probe, which is a
    // deliberate trade: it runs ONLY when exact full-text search returned
    // nothing, i.e. on a genuine typo, so the common path stays on the GIN
    // index and the rare path pays for itself.
    const fuzzy = await this.prisma.db.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM product
      WHERE deleted_at IS NULL
        AND GREATEST(word_similarity(${term}, name), word_similarity(${term}, sku)) > 0.4
      ORDER BY GREATEST(word_similarity(${term}, name), word_similarity(${term}, sku)) DESC,
               created_at DESC
      LIMIT ${SEARCH_RESULT_CAP}
    `;
    return fuzzy.map((row) => row.id);
  }

  private assertTaxClassification(
    type: string,
    hsnCode: string | undefined,
    sacCode: string | undefined,
  ): void {
    if (hsnCode && sacCode) {
      throw new ConflictError('A product carries an HSN or a SAC code, not both.');
    }
    if (type === 'SERVICE' && hsnCode) {
      throw new ConflictError(
        'Services are classified by SAC, not HSN. An HSN-coded service is a GST filing defect.',
      );
    }
    if (type !== 'SERVICE' && sacCode) {
      throw new ConflictError('Only SERVICE products are classified by SAC.');
    }
  }
}

function toSummary(row: ProductRow) {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    slug: row.slug,
    type: row.type,
    status: row.status,
    categoryId: row.categoryId,
    categoryName: row.category?.name ?? null,
    brandId: row.brandId,
    brandName: row.brand?.name ?? null,
    uomCode: row.uom?.code ?? null,
    hsnCode: row.hsnCode,
    sacCode: row.sacCode,
    gstRate: row.gstRate.toFixed(2),
    isSerialized: row.isSerialized,
    isBatchTracked: row.isBatchTracked,
    warrantyMonths: row.warrantyMonths,
    leadTimeDays: row.leadTimeDays,
    minOrderQty: row.minOrderQty.toFixed(4),
    tags: row.tags,
    revision: row.revision,
    specificationCount: row._count.specifications,
    bomComponentCount: row._count.bomComponents,
    createdAt: row.createdAt,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}
