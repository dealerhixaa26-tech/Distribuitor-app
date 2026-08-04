import { Injectable } from '@nestjs/common';
import {
  buildCategoryTree,
  type CreateCategoryDto,
  type ListCategoriesQuery,
  type UpdateCategoryDto,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import {
  AlreadyExistsError,
  ConflictError,
  NotFoundError,
} from '../../common/errors/domain.error';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import {
  buildPath,
  depthOf,
  rewritePath,
  subtreePattern,
  wouldCreateCycle,
} from '../territories/territory-path';

/**
 * Product categories — a tree, seeded from the company's published service
 * lines.
 *
 * Reuses `territory-path.ts` rather than reimplementing materialised paths. The
 * cycle guard and the subtree rewrite are already proven there and covered by
 * `territory-path.spec.ts`; a second copy would be a second place for the same
 * bug to live. See docs/17 §3.
 */
const CATEGORY_SELECT = {
  id: true,
  code: true,
  name: true,
  slug: true,
  parentId: true,
  path: true,
  depth: true,
  description: true,
  sortOrder: true,
  isActive: true,
  createdAt: true,
  _count: { select: { products: true } },
} satisfies Prisma.CategorySelect;

type CategoryRow = Prisma.CategoryGetPayload<{ select: typeof CATEGORY_SELECT }>;

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CategoriesService.name);
  }

  async list(query: ListCategoriesQuery) {
    const where: Prisma.CategoryWhereInput = {
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
    };

    if (query.parentId && query.includeDescendants) {
      const parent = await this.prisma.db.category.findFirst({
        where: { id: query.parentId },
        select: { path: true },
      });
      if (!parent) throw new NotFoundError('Category', query.parentId);
      // Trailing `%` is implied by `startsWith`; the stored path already ends
      // in a dot, so this cannot match a sibling whose id merely shares a prefix.
      where.path = { startsWith: parent.path };
    } else if (query.parentId) {
      where.parentId = query.parentId;
    }

    const rows = await this.prisma.db.category.findMany({
      where,
      orderBy: [{ path: 'asc' }],
      select: CATEGORY_SELECT,
    });

    return { data: rows.map(toSummary) };
  }

  /**
   * The whole tree, assembled with the shared contract helper.
   *
   * Return type is inferred, not annotated: these rows carry `createdAt` as a
   * `Date` until the transform interceptor serialises it at the edge, so
   * annotating the wire type here would not typecheck. HANDOFF §4.7.
   */
  async tree(includeInactive = false) {
    const rows = await this.prisma.db.category.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ path: 'asc' }],
      select: CATEGORY_SELECT,
    });
    return buildCategoryTree(rows.map(toSummary));
  }

  async findById(id: string) {
    const category = await this.prisma.db.category.findFirst({
      where: { id },
      select: CATEGORY_SELECT,
    });
    if (!category) throw new NotFoundError('Category', id);
    return toSummary(category);
  }

  async create(dto: CreateCategoryDto, actorId: string) {
    const clash = await this.prisma.db.category.findFirst({
      where: { OR: [{ code: dto.code }, ...(dto.slug ? [{ slug: dto.slug }] : [])] },
      select: { code: true, slug: true },
    });
    if (clash) {
      throw new AlreadyExistsError(
        'category',
        clash.code === dto.code ? 'code' : 'slug',
        clash.code === dto.code ? dto.code : (dto.slug ?? ''),
      );
    }

    let parentPath: string | null = null;
    if (dto.parentId) {
      const parent = await this.prisma.db.category.findFirst({
        where: { id: dto.parentId },
        select: { path: true },
      });
      if (!parent) throw new NotFoundError('Parent category', dto.parentId);
      parentPath = parent.path;
    }

    const created = await this.prisma.transaction(async (tx) => {
      // The path contains the node's own id, which exists only after insert.
      const category = await tx.category.create({
        data: {
          code: dto.code,
          name: dto.name,
          slug: dto.slug ?? slugify(dto.name),
          parentId: dto.parentId ?? null,
          description: dto.description ?? null,
          sortOrder: dto.sortOrder,
          imageDocumentId: dto.imageDocumentId ?? null,
          isActive: dto.isActive,
          path: '',
          depth: 0,
          createdById: actorId,
        },
        select: { id: true },
      });

      const path = buildPath(parentPath, category.id);

      const result = await tx.category.update({
        where: { id: category.id },
        data: { path, depth: depthOf(path) },
        select: CATEGORY_SELECT,
      });

      await this.audit.record(tx, {
        action: 'category.created',
        entityType: 'Category',
        entityId: category.id,
        after: { code: dto.code, name: dto.name, parentId: dto.parentId ?? null },
      });

      return result;
    });

    this.logger.info({ categoryId: created.id, code: created.code }, 'Category created');
    return toSummary(created);
  }

  async update(id: string, dto: UpdateCategoryDto, actorId: string) {
    const before = await this.prisma.db.category.findFirst({
      where: { id },
      select: { id: true, name: true, slug: true, description: true, sortOrder: true, isActive: true },
    });
    if (!before) throw new NotFoundError('Category', id);

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.category.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.imageDocumentId !== undefined ? { imageDocumentId: dto.imageDocumentId } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          updatedById: actorId,
        },
        select: CATEGORY_SELECT,
      });

      const diff = AuditService.diff(before, {
        name: result.name,
        slug: result.slug,
        description: result.description,
        sortOrder: result.sortOrder,
        isActive: result.isActive,
      });

      if (diff.changed.length) {
        await this.audit.record(tx, {
          action: 'category.updated',
          entityType: 'Category',
          entityId: id,
          before: diff.before,
          after: diff.after,
        });
      }

      return result;
    });

    return toSummary(updated);
  }

  /**
   * Moves a subtree, rewriting every descendant's path in one transaction.
   *
   * A partially-rewritten tree has nodes whose paths point at a parent they are
   * no longer under — which silently breaks category-scoped discount rules,
   * since those resolve against the ancestor chain.
   */
  async move(id: string, newParentId: string | null, actorId: string) {
    const node = await this.prisma.db.category.findFirst({
      where: { id },
      select: { id: true, path: true, parentId: true, code: true },
    });
    if (!node) throw new NotFoundError('Category', id);
    if (newParentId === id) throw new ConflictError('A category cannot be its own parent.');

    let newParentPath: string | null = null;
    if (newParentId) {
      const parent = await this.prisma.db.category.findFirst({
        where: { id: newParentId },
        select: { id: true, path: true },
      });
      if (!parent) throw new NotFoundError('Parent category', newParentId);

      if (wouldCreateCycle(node.path, parent.path)) {
        throw new ConflictError(
          'Cannot move a category beneath one of its own descendants — that would create a cycle.',
        );
      }
      newParentPath = parent.path;
    }

    const oldPath = node.path;
    const newPath = buildPath(newParentPath, node.id);

    const updated = await this.prisma.transaction(async (tx) => {
      const subtree = await tx.category.findMany({
        where: { path: { startsWith: subtreePattern(oldPath).replace(/%$/, '') } },
        select: { id: true, path: true },
      });

      for (const descendant of subtree) {
        const rewritten = rewritePath(descendant.path, oldPath, newPath);
        await tx.category.update({
          where: { id: descendant.id },
          data: { path: rewritten, depth: depthOf(rewritten) },
        });
      }

      const result = await tx.category.update({
        where: { id },
        data: { parentId: newParentId, updatedById: actorId },
        select: CATEGORY_SELECT,
      });

      await this.audit.record(tx, {
        action: 'category.moved',
        entityType: 'Category',
        entityId: id,
        before: { parentId: node.parentId, path: oldPath },
        after: { parentId: newParentId, path: newPath },
        metadata: { descendantsRewritten: subtree.length - 1 },
      });

      return result;
    });

    this.logger.info({ categoryId: id, from: oldPath, to: newPath }, 'Category subtree moved');
    return toSummary(updated);
  }

  async remove(id: string, actorId: string): Promise<void> {
    const category = await this.prisma.db.category.findFirst({
      where: { id },
      select: {
        id: true,
        code: true,
        _count: { select: { products: true, children: true } },
      },
    });
    if (!category) throw new NotFoundError('Category', id);

    // Refused rather than cascaded. Removing a category that still classifies
    // products would leave them unclassified and silently drop them out of
    // every category-filtered list and category-scoped discount.
    if (category._count.products > 0) {
      throw new ConflictError(
        `Cannot delete ${category.code}: ${category._count.products} product(s) are still in it. ` +
          'Reassign them first, or deactivate the category instead.',
      );
    }
    if (category._count.children > 0) {
      throw new ConflictError(
        `Cannot delete ${category.code}: it still has ${category._count.children} subcategor(ies).`,
      );
    }

    await this.prisma.transaction(async (tx) => {
      // Soft delete — `.delete()` throws by design on soft-deletable models.
      await tx.category.softDelete({ id });
      await this.audit.record(tx, {
        action: 'category.deleted',
        entityType: 'Category',
        entityId: id,
        before: { code: category.code },
        metadata: { actorId },
      });
    });
  }

  /** Ancestor ids of a category, itself included — used by discount resolution. */
  async ancestorIdsOf(categoryId: string): Promise<string[]> {
    const category = await this.prisma.db.category.findFirst({
      where: { id: categoryId },
      select: { path: true },
    });
    return category ? category.path.split('.').filter(Boolean) : [];
  }
}

function toSummary(row: CategoryRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    slug: row.slug,
    parentId: row.parentId,
    path: row.path,
    depth: row.depth,
    description: row.description,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    productCount: row._count.products,
    createdAt: row.createdAt,
  };
}

/** Fallback when a slug is not supplied. Matches `slugSchema` in contracts. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    // Strip combining diacritics so "Système" slugs as "systeme".
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}
