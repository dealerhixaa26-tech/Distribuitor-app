import { Injectable } from '@nestjs/common';
import type {
  CreateTerritoryDto,
  TerritoryNode,
  TerritorySummary,
  UpdateTerritoryDto,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { AlreadyExistsError, ConflictError, NotFoundError } from '../../common/errors/domain.error';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AccessService } from '../auth/services/access.service';
import { buildPath, depthOf, rewritePath, subtreePattern, wouldCreateCycle } from './territory-path';

const TERRITORY_SELECT = {
  id: true,
  code: true,
  name: true,
  type: true,
  parentId: true,
  path: true,
  depth: true,
  stateId: true,
  managerId: true,
  description: true,
  isActive: true,
  createdAt: true,
  state: { select: { name: true, gstStateCode: true } },
  manager: { select: { firstName: true, lastName: true } },
  _count: { select: { children: true } },
} satisfies Prisma.TerritorySelect;

@Injectable()
export class TerritoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TerritoriesService.name);
  }

  /**
   * Flat list. Scoped automatically by the Prisma extension, so a
   * territory-scoped user sees only their own subtree.
   */
  async list(includeInactive = false): Promise<TerritorySummary[]> {
    const rows = await this.prisma.db.territory.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ depth: 'asc' }, { name: 'asc' }],
      select: TERRITORY_SELECT,
    });
    return rows.map(toSummary);
  }

  /**
   * The same rows, nested.
   *
   * Assembled in memory rather than with a recursive query: a territory tree is
   * tens of nodes, not thousands, and one flat indexed read plus an O(n) link
   * pass beats a recursive CTE at this size. It also keeps the scope filter in
   * play, which a raw recursive query would bypass.
   */
  async tree(includeInactive = false): Promise<TerritoryNode[]> {
    const flat = await this.list(includeInactive);

    const byId = new Map<string, TerritoryNode>(
      flat.map((node) => [node.id, { ...node, children: [] }]),
    );
    const roots: TerritoryNode[] = [];

    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      // A node whose parent is out of scope surfaces as a root rather than
      // vanishing — a scoped user should still see their own subtree's top.
      if (parent) parent.children.push(node);
      else roots.push(node);
    }

    return roots;
  }

  async findById(id: string): Promise<TerritorySummary> {
    const territory = await this.prisma.db.territory.findFirst({
      where: { id },
      select: TERRITORY_SELECT,
    });
    if (!territory) throw new NotFoundError('Territory', id);
    return toSummary(territory);
  }

  async create(dto: CreateTerritoryDto, actorId: string): Promise<TerritorySummary> {
    const existing = await this.prisma.db.territory.findUnique({
      where: { code: dto.code },
      select: { id: true },
    });
    if (existing) throw new AlreadyExistsError('territory', 'code', dto.code);

    let parentPath: string | null = null;
    if (dto.parentId) {
      const parent = await this.prisma.db.territory.findFirst({
        where: { id: dto.parentId },
        select: { path: true },
      });
      if (!parent) throw new NotFoundError('Parent territory', dto.parentId);
      parentPath = parent.path;
    }

    const created = await this.prisma.transaction(async (tx) => {
      // The path contains the node's own id, which only exists after insert —
      // hence create-then-set rather than one statement.
      const territory = await tx.territory.create({
        data: {
          code: dto.code,
          name: dto.name,
          type: dto.type,
          parentId: dto.parentId ?? null,
          stateId: dto.stateId ?? null,
          managerId: dto.managerId ?? null,
          description: dto.description ?? null,
          path: '',
          depth: 0,
          createdById: actorId,
        },
        select: { id: true },
      });

      const path = buildPath(parentPath, territory.id);

      const result = await tx.territory.update({
        where: { id: territory.id },
        data: { path, depth: depthOf(path) },
        select: TERRITORY_SELECT,
      });

      await this.audit.record(tx, {
        action: 'territory.created',
        entityType: 'Territory',
        entityId: territory.id,
        after: { code: dto.code, name: dto.name, parentId: dto.parentId ?? null },
      });

      return result;
    });

    this.logger.info({ territoryId: created.id, code: created.code }, 'Territory created');
    return toSummary(created);
  }

  async update(id: string, dto: UpdateTerritoryDto, actorId: string): Promise<TerritorySummary> {
    const before = await this.prisma.db.territory.findFirst({
      where: { id },
      select: { id: true, name: true, type: true, managerId: true, stateId: true, description: true },
    });
    if (!before) throw new NotFoundError('Territory', id);

    // Reparenting rewrites an entire subtree's paths, so it goes through
    // `move()` rather than being a side effect of a name edit.
    if (dto.parentId !== undefined) {
      throw new ConflictError(
        'Use POST /territories/:id/move to change a territory’s parent — it rewrites the whole subtree.',
      );
    }

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.territory.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.stateId !== undefined ? { stateId: dto.stateId } : {}),
          ...(dto.managerId !== undefined ? { managerId: dto.managerId } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          updatedById: actorId,
        },
        select: TERRITORY_SELECT,
      });

      const diff = AuditService.diff(before, {
        name: result.name,
        type: result.type,
        managerId: result.managerId,
        stateId: result.stateId,
        description: result.description,
      });

      if (diff.changed.length) {
        await this.audit.record(tx, {
          action: 'territory.updated',
          entityType: 'Territory',
          entityId: id,
          before: diff.before,
          after: diff.after,
        });
      }

      return result;
    });

    // A manager change alters who is scoped where, so cached access is stale.
    if (dto.managerId !== undefined) await this.access.invalidateAll();

    return toSummary(updated);
  }

  /**
   * Moves a subtree, rewriting every descendant's path and depth.
   *
   * Done in one transaction: a partially-rewritten tree has nodes whose paths
   * point at a parent they are no longer under, which corrupts every scope
   * check that consults it.
   */
  async move(id: string, newParentId: string | null, actorId: string): Promise<TerritorySummary> {
    const node = await this.prisma.db.territory.findFirst({
      where: { id },
      select: { id: true, path: true, parentId: true, code: true },
    });
    if (!node) throw new NotFoundError('Territory', id);
    if (newParentId === id) throw new ConflictError('A territory cannot be its own parent.');

    let newParentPath: string | null = null;
    if (newParentId) {
      const parent = await this.prisma.db.territory.findFirst({
        where: { id: newParentId },
        select: { id: true, path: true },
      });
      if (!parent) throw new NotFoundError('Parent territory', newParentId);

      // Reparenting under one's own descendant detaches the subtree into an
      // unreachable cycle.
      if (wouldCreateCycle(node.path, parent.path)) {
        throw new ConflictError(
          'Cannot move a territory beneath one of its own descendants — that would create a cycle.',
        );
      }
      newParentPath = parent.path;
    }

    const oldPath = node.path;
    const newPath = buildPath(newParentPath, node.id);

    const updated = await this.prisma.transaction(async (tx) => {
      // Every node at or below the one being moved, itself included.
      const subtree = await tx.territory.findMany({
        where: { path: { startsWith: subtreePattern(oldPath).replace(/%$/, '') } },
        select: { id: true, path: true },
      });

      for (const descendant of subtree) {
        const rewritten = rewritePath(descendant.path, oldPath, newPath);
        await tx.territory.update({
          where: { id: descendant.id },
          data: { path: rewritten, depth: depthOf(rewritten) },
        });
      }

      const result = await tx.territory.update({
        where: { id },
        data: { parentId: newParentId, updatedById: actorId },
        select: TERRITORY_SELECT,
      });

      await this.audit.record(tx, {
        // A move changes who can see what, so it is a security event.
        category: 'SECURITY',
        action: 'territory.moved',
        entityType: 'Territory',
        entityId: id,
        before: { parentId: node.parentId, path: oldPath },
        after: { parentId: newParentId, path: newPath },
        metadata: { descendantsRewritten: subtree.length - 1 },
      });

      return result;
    });

    await this.access.invalidateAll();

    this.logger.warn(
      { territoryId: id, code: node.code, from: oldPath, to: newPath },
      'Territory subtree moved',
    );
    return toSummary(updated);
  }

  async remove(id: string, actorId: string): Promise<void> {
    const territory = await this.prisma.db.territory.findFirst({
      where: { id },
      select: { id: true, code: true, _count: { select: { children: true, warehouses: true } } },
    });
    if (!territory) throw new NotFoundError('Territory', id);

    // Deleting a parent would orphan its children's paths. Requiring the tree
    // to be flattened first keeps the invariant enforceable.
    if (territory._count.children > 0) {
      throw new ConflictError(
        `This territory has ${territory._count.children} child territor${
          territory._count.children === 1 ? 'y' : 'ies'
        }. Move or remove them first.`,
      );
    }
    if (territory._count.warehouses > 0) {
      throw new ConflictError(
        `${territory._count.warehouses} warehouse(s) are assigned to this territory.`,
      );
    }

    await this.prisma.transaction(async (tx) => {
      await tx.territory.softDelete({ id });
      await this.audit.record(tx, {
        action: 'territory.deleted',
        entityType: 'Territory',
        entityId: id,
        before: { code: territory.code },
        metadata: { actorId },
      });
    });

    await this.access.invalidateAll();
  }

  /**
   * Expands a set of territory ids to include every descendant.
   *
   * This is what makes a scope assignment to a ZONE mean "the zone and
   * everything under it" rather than "that one node".
   */
  async expandToSubtrees(territoryIds: readonly string[]): Promise<string[]> {
    if (territoryIds.length === 0) return [];

    const roots = await this.prisma.db.territory.findMany({
      where: { id: { in: [...territoryIds] } },
      select: { path: true },
    });
    if (roots.length === 0) return [];

    const descendants = await this.prisma.db.territory.findMany({
      where: { OR: roots.map((root) => ({ path: { startsWith: root.path } })) },
      select: { id: true },
    });

    return descendants.map((row) => row.id);
  }
}

type TerritoryRow = Prisma.TerritoryGetPayload<{ select: typeof TERRITORY_SELECT }>;

function toSummary(territory: TerritoryRow): TerritorySummary {
  return {
    id: territory.id,
    code: territory.code,
    name: territory.name,
    type: territory.type,
    parentId: territory.parentId,
    path: territory.path,
    depth: territory.depth,
    stateId: territory.stateId,
    stateName: territory.state?.name ?? null,
    gstStateCode: territory.state?.gstStateCode ?? null,
    managerId: territory.managerId,
    managerName: territory.manager
      ? `${territory.manager.firstName} ${territory.manager.lastName}`
      : null,
    description: territory.description,
    isActive: territory.isActive,
    childCount: territory._count.children,
  };
}
