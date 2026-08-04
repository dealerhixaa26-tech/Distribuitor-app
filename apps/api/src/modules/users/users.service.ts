import { Injectable } from '@nestjs/common';
import {
  DOMAIN_EVENTS,
  type InviteUserDto,
  type ListUsersQuery,
  type RoleAssignmentDto,
  type UpdateUserDto,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import { keysetWhere, parseSort, toListResult } from '../../common/utils/pagination.util';
import {
  AlreadyExistsError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain.error';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { AuthService } from '../auth/auth.service';
import { AccessService } from '../auth/services/access.service';

const SORTABLE = ['createdAt', 'lastLoginAt', 'email', 'firstName'] as const;

const USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  avatarUrl: true,
  status: true,
  emailVerifiedAt: true,
  mfaEnabled: true,
  lastLoginAt: true,
  createdAt: true,
  roles: {
    select: {
      id: true,
      roleId: true,
      scopeType: true,
      scopeId: true,
      role: { select: { key: true, name: true } },
    },
  },
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly access: AccessService,
    private readonly auth: AuthService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(UsersService.name);
  }

  async list(query: ListUsersQuery) {
    const where: Prisma.UserWhereInput = {
      ...(query.status?.length ? { status: { in: query.status } } : {}),
      ...(query.roleKey ? { roles: { some: { role: { key: query.roleKey } } } } : {}),
      ...(query.q
        ? {
            OR: [
              { email: { contains: query.q, mode: 'insensitive' } },
              { firstName: { contains: query.q, mode: 'insensitive' } },
              { lastName: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const cursorWhere = keysetWhere(query.cursor);

    const rows = await this.prisma.db.user.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: parseSort(query.sort, SORTABLE),
      // One extra row tells us whether another page exists, without a COUNT.
      take: query.limit + 1,
      select: USER_SELECT,
    });

    // Only paid for when the caller explicitly asks — a COUNT over a large
    // filtered set is frequently more expensive than the page itself.
    const totalCount = query.includeTotal
      ? await this.prisma.db.user.count({ where })
      : undefined;

    const result = toListResult(rows, query.limit, totalCount);
    return { ...result, data: result.data.map(toSummary) };
  }

  async findById(id: string) {
    const user = await this.prisma.db.user.findFirst({
      where: { id },
      select: USER_SELECT,
    });
    if (!user) throw new NotFoundError('User', id);
    return toSummary(user);
  }

  /**
   * Creates an INVITED user and emails an invitation.
   *
   * No password is set here: the invitee chooses their own via the token, so a
   * temporary credential never exists to be intercepted or reused.
   */
  async invite(dto: InviteUserDto, invitedById: string) {
    const existing = await this.prisma.db.user.findFirst({
      where: { email: dto.email },
      select: { id: true, deletedAt: true },
    });
    if (existing) throw new AlreadyExistsError('user', 'email', dto.email);

    await this.assertRolesAssignable(dto.roles);

    const inviter = await this.prisma.db.user.findFirst({
      where: { id: invitedById },
      select: { firstName: true, lastName: true },
    });

    const roleNames = await this.prisma.db.role.findMany({
      where: { id: { in: dto.roles.map((r) => r.roleId) } },
      select: { name: true },
    });

    const created = await this.prisma.transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone ?? null,
          status: 'INVITED',
          createdById: invitedById,
          roles: {
            create: dto.roles.map((assignment) => ({
              roleId: assignment.roleId,
              scopeType: assignment.scopeType,
              scopeId: assignment.scopeId,
              assignedById: invitedById,
            })),
          },
        },
        select: USER_SELECT,
      });

      const token = await this.auth.createInvitationToken(tx, user.id, user.email);

      await this.audit.record(tx, {
        category: 'DATA',
        action: 'user.invited',
        entityType: 'User',
        entityId: user.id,
        after: { email: user.email, roles: dto.roles },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.USER_INVITED,
        { type: 'User', id: user.id },
        {
          email: user.email,
          name: `${dto.firstName} ${dto.lastName}`,
          token,
          roleName: roleNames.map((r) => r.name).join(', '),
          inviterName: inviter ? `${inviter.firstName} ${inviter.lastName}` : 'An administrator',
        },
      );

      return user;
    });

    this.logger.info({ userId: created.id, email: created.email }, 'User invited');
    return toSummary(created);
  }

  async update(id: string, dto: UpdateUserDto, actorId: string) {
    const before = await this.prisma.db.user.findFirst({
      where: { id },
      select: { id: true, firstName: true, lastName: true, phone: true },
    });
    if (!before) throw new NotFoundError('User', id);

    const updated = await this.prisma.transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id },
        data: { ...dto, updatedById: actorId },
        select: USER_SELECT,
      });

      const diff = AuditService.diff(before, {
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
      });

      if (diff.changed.length) {
        await this.audit.record(tx, {
          category: 'DATA',
          action: 'user.updated',
          entityType: 'User',
          entityId: id,
          before: diff.before,
          after: diff.after,
        });
      }

      return user;
    });

    return toSummary(updated);
  }

  /** Replaces a user's role assignments wholesale. */
  async setRoles(id: string, roles: RoleAssignmentDto[], actorId: string) {
    const user = await this.prisma.db.user.findFirst({
      where: { id },
      select: { id: true, roles: { select: { roleId: true, scopeType: true, scopeId: true } } },
    });
    if (!user) throw new NotFoundError('User', id);

    await this.assertRolesAssignable(roles);
    await this.assertNotLastSuperAdmin(id, roles);

    const updated = await this.prisma.transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userRole.createMany({
        data: roles.map((assignment) => ({
          userId: id,
          roleId: assignment.roleId,
          scopeType: assignment.scopeType,
          scopeId: assignment.scopeId,
          assignedById: actorId,
        })),
      });

      await this.audit.record(tx, {
        // A role change is a privilege change, so it is a SECURITY event, not
        // an ordinary data edit.
        category: 'SECURITY',
        action: 'user.roles_changed',
        entityType: 'User',
        entityId: id,
        before: { roles: user.roles },
        after: { roles },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.SECURITY_SENSITIVE_FIELD_CHANGED,
        { type: 'User', id },
        { entityType: 'User', entityId: id, fields: 'roles', userId: actorId },
      );

      return tx.user.findFirstOrThrow({ where: { id }, select: USER_SELECT });
    });

    // Without this the user keeps their old permissions until the cache
    // expires — a revoked role would stay effective for up to an hour.
    await this.access.invalidate(id);

    return toSummary(updated);
  }

  async suspend(id: string, reason: string, actorId: string) {
    if (id === actorId) throw new ConflictError('You cannot suspend your own account.');

    const user = await this.prisma.db.user.findFirst({
      where: { id },
      select: { id: true, status: true },
    });
    if (!user) throw new NotFoundError('User', id);

    await this.assertNotLastSuperAdmin(id, []);

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.user.update({
        where: { id },
        data: { status: 'SUSPENDED', updatedById: actorId },
        select: USER_SELECT,
      });

      // Suspension must take effect now, not when their token expires.
      await tx.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: this.clock.now(), revokedReason: 'USER_SUSPENDED' },
      });

      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'user.suspended',
        entityType: 'User',
        entityId: id,
        before: { status: user.status },
        after: { status: 'SUSPENDED' },
        metadata: { reason },
      });

      return result;
    });

    await this.access.invalidate(id);
    return toSummary(updated);
  }

  async reactivate(id: string, actorId: string) {
    const user = await this.prisma.db.user.findFirst({
      where: { id },
      select: { id: true, status: true },
    });
    if (!user) throw new NotFoundError('User', id);

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.user.update({
        where: { id },
        data: { status: 'ACTIVE', failedLoginAttempts: 0, lockedUntil: null, updatedById: actorId },
        select: USER_SELECT,
      });

      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'user.reactivated',
        entityType: 'User',
        entityId: id,
        before: { status: user.status },
        after: { status: 'ACTIVE' },
      });

      return result;
    });

    await this.access.invalidate(id);
    return toSummary(updated);
  }

  async remove(id: string, actorId: string): Promise<void> {
    if (id === actorId) throw new ConflictError('You cannot delete your own account.');

    const user = await this.prisma.db.user.findFirst({
      where: { id },
      select: { id: true, email: true, isSystem: true },
    });
    if (!user) throw new NotFoundError('User', id);
    if (user.isSystem) throw new ConflictError('System accounts cannot be deleted.');

    await this.assertNotLastSuperAdmin(id, []);

    await this.prisma.transaction(async (tx) => {
      // Soft delete — the extension rewrites this to set deletedAt. History
      // referencing this user stays intact.
      await tx.user.softDelete({ id });
      await tx.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: this.clock.now(), revokedReason: 'USER_DELETED' },
      });
      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'user.deleted',
        entityType: 'User',
        entityId: id,
        before: { email: user.email },
      });
    });

    await this.access.invalidate(id);
  }

  /** Re-issues an invitation for a user still in INVITED state. */
  async resendInvite(id: string) {
    const user = await this.prisma.db.user.findFirst({
      where: { id },
      select: { id: true, email: true, firstName: true, lastName: true, status: true },
    });
    if (!user) throw new NotFoundError('User', id);
    if (user.status !== 'INVITED') {
      throw new ConflictError('This user has already accepted their invitation.');
    }

    await this.prisma.transaction(async (tx) => {
      await tx.emailVerificationToken.updateMany({
        where: { userId: id, usedAt: null },
        data: { usedAt: this.clock.now() },
      });

      const token = await this.auth.createInvitationToken(tx, id, user.email);

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.USER_INVITED,
        { type: 'User', id },
        {
          email: user.email,
          name: `${user.firstName} ${user.lastName}`,
          token,
          roleName: 'a team member',
          inviterName: 'An administrator',
        },
      );
    });
  }

  private async assertRolesAssignable(roles: RoleAssignmentDto[]): Promise<void> {
    if (!roles.length) return;

    const found = await this.prisma.db.role.findMany({
      where: { id: { in: roles.map((r) => r.roleId) } },
      select: { id: true, key: true, scopeType: true },
    });

    const byId = new Map(found.map((role) => [role.id, role]));

    for (const assignment of roles) {
      const role = byId.get(assignment.roleId);
      if (!role) throw new NotFoundError('Role', assignment.roleId);

      // A role declares the scope it is designed for. Assigning a
      // TERRITORY-scoped role globally would silently widen its reach far
      // beyond what its permission set assumes.
      if (role.scopeType !== assignment.scopeType) {
        throw new ValidationError(
          `Role ${role.key} must be assigned with scope ${role.scopeType}, not ${assignment.scopeType}.`,
          [{ field: 'roles', code: 'SCOPE_MISMATCH', message: `Expected ${role.scopeType}` }],
        );
      }
    }
  }

  /**
   * Refuses to remove the last super admin.
   *
   * Without this, one careless role change locks everyone out of the system
   * permanently — there is no recovery path that does not involve direct
   * database access.
   */
  private async assertNotLastSuperAdmin(
    userId: string,
    incomingRoles: RoleAssignmentDto[],
  ): Promise<void> {
    const superAdminRole = await this.prisma.db.role.findUnique({
      where: { key: 'SUPER_ADMIN' },
      select: { id: true },
    });
    if (!superAdminRole) return;

    const isCurrentlySuperAdmin = await this.prisma.db.userRole.findFirst({
      where: { userId, roleId: superAdminRole.id },
      select: { id: true },
    });
    if (!isCurrentlySuperAdmin) return;

    const willRemainSuperAdmin = incomingRoles.some((r) => r.roleId === superAdminRole.id);
    if (willRemainSuperAdmin) return;

    const others = await this.prisma.db.userRole.count({
      where: {
        roleId: superAdminRole.id,
        userId: { not: userId },
        user: { status: 'ACTIVE', deletedAt: null },
      },
    });

    if (others === 0) {
      throw new ConflictError(
        'This is the only active Super Administrator. Promote another user first — ' +
          'removing this role would lock everyone out of the system.',
      );
    }
  }
}

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

function toSummary(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    status: user.status,
    emailVerified: Boolean(user.emailVerifiedAt),
    mfaEnabled: user.mfaEnabled,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    roles: user.roles.map((assignment) => ({
      id: assignment.id,
      roleId: assignment.roleId,
      roleKey: assignment.role.key,
      roleName: assignment.role.name,
      scopeType: assignment.scopeType,
      scopeId: assignment.scopeId,
    })),
  };
}
