import { Injectable } from '@nestjs/common';
import {
  ALL_PERMISSIONS,
  findSegregationViolations,
  type CreateRoleDto,
  type UpdateRoleDto,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import {
  AlreadyExistsError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain.error';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AccessService } from '../auth/services/access.service';

const ROLE_SELECT = {
  id: true,
  key: true,
  name: true,
  description: true,
  scopeType: true,
  level: true,
  isSystem: true,
  maxDiscountPercent: true,
  maxOrderValue: true,
  createdAt: true,
  permissions: { select: { permission: { select: { key: true } } } },
  _count: { select: { users: true } },
} satisfies Prisma.RoleSelect;

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RolesService.name);
  }

  async list() {
    const roles = await this.prisma.db.role.findMany({
      orderBy: [{ level: 'desc' }, { name: 'asc' }],
      select: ROLE_SELECT,
    });
    return roles.map(toSummary);
  }

  async findById(id: string) {
    const role = await this.prisma.db.role.findFirst({ where: { id }, select: ROLE_SELECT });
    if (!role) throw new NotFoundError('Role', id);
    return toSummary(role);
  }

  /** The full permission catalogue, grouped for the matrix UI. */
  async catalogue() {
    const permissions = await this.prisma.db.permission.findMany({
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
      select: { key: true, resource: true, action: true, description: true },
    });

    const grouped = new Map<string, typeof permissions>();
    for (const permission of permissions) {
      const bucket = grouped.get(permission.resource) ?? [];
      bucket.push(permission);
      grouped.set(permission.resource, bucket);
    }

    return [...grouped.entries()].map(([resource, items]) => ({ resource, permissions: items }));
  }

  async create(dto: CreateRoleDto, actorId: string) {
    const existing = await this.prisma.db.role.findUnique({
      where: { key: dto.key },
      select: { id: true },
    });
    if (existing) throw new AlreadyExistsError('role', 'key', dto.key);

    this.assertPermissionsExist(dto.permissions);
    this.assertSegregationOfDuties(dto.permissions);

    const permissionIds = await this.resolvePermissionIds(dto.permissions);

    const created = await this.prisma.transaction(async (tx) => {
      const role = await tx.role.create({
        data: {
          key: dto.key,
          name: dto.name,
          description: dto.description ?? null,
          scopeType: dto.scopeType,
          level: dto.level,
          isSystem: false,
          maxDiscountPercent: dto.maxDiscountPercent ?? null,
          maxOrderValue: dto.maxOrderValue ?? null,
          permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
        },
        select: ROLE_SELECT,
      });

      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'role.created',
        entityType: 'Role',
        entityId: role.id,
        after: { key: dto.key, permissions: dto.permissions },
        metadata: { actorId },
      });

      return role;
    });

    this.logger.info({ roleId: created.id, key: created.key }, 'Role created');
    return toSummary(created);
  }

  async update(id: string, dto: UpdateRoleDto, actorId: string) {
    const role = await this.prisma.db.role.findFirst({ where: { id }, select: ROLE_SELECT });
    if (!role) throw new NotFoundError('Role', id);

    // System roles are reconciled from prisma/seed/permissions.seed.ts on every
    // deploy. Allowing edits here would let a change survive until the next
    // deploy silently reverted it — worse than refusing outright.
    if (role.isSystem) {
      throw new ConflictError(
        'System roles are defined in code and reconciled on deploy. ' +
          'Create a custom role instead of editing this one.',
      );
    }

    if (dto.permissions) {
      this.assertPermissionsExist(dto.permissions);
      this.assertSegregationOfDuties(dto.permissions);
    }

    const updated = await this.prisma.transaction(async (tx) => {
      if (dto.permissions) {
        const permissionIds = await this.resolvePermissionIds(dto.permissions);
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId: id, permissionId })),
        });
      }

      const result = await tx.role.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.scopeType !== undefined ? { scopeType: dto.scopeType } : {}),
          ...(dto.level !== undefined ? { level: dto.level } : {}),
          ...(dto.maxDiscountPercent !== undefined
            ? { maxDiscountPercent: dto.maxDiscountPercent }
            : {}),
          ...(dto.maxOrderValue !== undefined ? { maxOrderValue: dto.maxOrderValue } : {}),
        },
        select: ROLE_SELECT,
      });

      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'role.updated',
        entityType: 'Role',
        entityId: id,
        before: { permissions: role.permissions.map((p) => p.permission.key) },
        after: { permissions: dto.permissions ?? undefined },
        metadata: { actorId },
      });

      return result;
    });

    // A role's permission set changed, which affects everyone holding it.
    // Finding exactly who costs a query; clearing the namespace errs toward
    // correctness.
    await this.access.invalidateAll();

    return toSummary(updated);
  }

  async remove(id: string, actorId: string): Promise<void> {
    const role = await this.prisma.db.role.findFirst({
      where: { id },
      select: { id: true, key: true, isSystem: true, _count: { select: { users: true } } },
    });
    if (!role) throw new NotFoundError('Role', id);
    if (role.isSystem) throw new ConflictError('System roles cannot be deleted.');

    if (role._count.users > 0) {
      throw new ConflictError(
        `${role._count.users} user(s) still hold this role. Reassign them before deleting it.`,
      );
    }

    await this.prisma.transaction(async (tx) => {
      await tx.role.delete({ where: { id } });
      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'role.deleted',
        entityType: 'Role',
        entityId: id,
        before: { key: role.key },
        metadata: { actorId },
      });
    });
  }

  private assertPermissionsExist(permissions: readonly string[]): void {
    const known = new Set<string>(ALL_PERMISSIONS);
    const unknown = permissions.filter((permission) => !known.has(permission));

    if (unknown.length) {
      throw new ValidationError(`Unknown permission(s): ${unknown.join(', ')}`, [
        { field: 'permissions', code: 'UNKNOWN_PERMISSION', message: unknown.join(', ') },
      ]);
    }
  }

  /**
   * Refuses to create a role that combines a separated pair.
   *
   * Financial controls that rely on people remembering them are not controls.
   * The error explains WHY rather than just refusing — an administrator who
   * does not understand the rule will work around it.
   */
  private assertSegregationOfDuties(permissions: readonly string[]): void {
    const violations = findSegregationViolations(permissions);
    if (!violations.length) return;

    throw new ValidationError(
      'This combination of permissions breaks segregation of duties.',
      violations.map((violation) => ({
        field: 'permissions',
        code: 'SEGREGATION_OF_DUTIES',
        message: `${violation.a} + ${violation.b}: ${violation.reason}`,
      })),
    );
  }

  private async resolvePermissionIds(keys: readonly string[]): Promise<string[]> {
    const rows = await this.prisma.db.permission.findMany({
      where: { key: { in: [...keys] } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
}

type RoleRow = Prisma.RoleGetPayload<{ select: typeof ROLE_SELECT }>;

function toSummary(role: RoleRow) {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    scopeType: role.scopeType,
    level: role.level,
    isSystem: role.isSystem,
    maxDiscountPercent: role.maxDiscountPercent,
    maxOrderValue: role.maxOrderValue,
    permissions: role.permissions.map((grant) => grant.permission.key).sort(),
    userCount: role._count.users,
  };
}
