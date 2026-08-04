import { Injectable } from '@nestjs/common';
import type { EffectiveAccess, Permission, ScopeType } from '@hixaa/contracts';
import { PinoLogger } from 'nestjs-pino';
import { CacheKeys, RedisService } from '../../../infrastructure/cache/redis.service';
import { ClockService } from '../../../common/utils/clock.service';
import { AppConfigService } from '../../../config/app-config.service';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { TokenService } from './token.service';

/**
 * Resolves a user's effective authority: which permissions they hold, and over
 * which records. This is the input to both the permissions guard and the
 * repository-level scope filter (ADR-0003).
 *
 * A user may hold several role assignments. Permissions are the UNION of their
 * roles' grants; scope is the union of their scopes. Someone can be a Sales
 * Manager for West and a Sales Executive for Central with no special-casing.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AccessService.name);
  }

  /**
   * Effective access for a user, cached in Redis.
   *
   * Cached because it is read on every authenticated request and changes
   * rarely. Invalidated explicitly whenever a role assignment or a role's
   * permission set changes — see `invalidate`.
   */
  async resolve(userId: string): Promise<EffectiveAccess> {
    const key = CacheKeys.userAccess(userId);

    const cached = await this.redis.get<EffectiveAccess>(key);
    if (cached) return cached;

    const access = await this.computeFromDatabase(userId);
    await this.redis.set(key, access, this.config.cache.referenceTtl);
    return access;
  }

  /** Always reads the database. Used where staleness is unacceptable. */
  async resolveFresh(userId: string): Promise<EffectiveAccess> {
    const access = await this.computeFromDatabase(userId);
    await this.redis.set(CacheKeys.userAccess(userId), access, this.config.cache.referenceTtl);
    return access;
  }

  private async computeFromDatabase(userId: string): Promise<EffectiveAccess> {
    const assignments = await this.prisma.db.userRole.findMany({
      where: {
        userId,
        // An expired assignment grants nothing — temporary elevation must
        // actually be temporary. The clock is injected so this boundary can be
        // tested against a fixed time rather than by sleeping.
        OR: [{ expiresAt: null }, { expiresAt: { gt: this.clock.now() } }],
      },
      select: {
        scopeType: true,
        scopeId: true,
        role: {
          select: {
            key: true,
            deletedAt: true,
            permissions: { select: { permission: { select: { key: true } } } },
          },
        },
      },
    });

    const permissions = new Set<string>();
    const territoryIds = new Set<string>();
    const distributorIds = new Set<string>();
    let hasGlobal = false;
    let hasTerritory = false;
    let hasDistributor = false;

    for (const assignment of assignments) {
      if (assignment.role.deletedAt) continue;

      for (const grant of assignment.role.permissions) {
        permissions.add(grant.permission.key);
      }

      switch (assignment.scopeType) {
        case 'GLOBAL':
          hasGlobal = true;
          break;
        case 'TERRITORY':
          hasTerritory = true;
          if (assignment.scopeId) territoryIds.add(assignment.scopeId);
          break;
        case 'DISTRIBUTOR':
          hasDistributor = true;
          if (assignment.scopeId) distributorIds.add(assignment.scopeId);
          break;
      }
    }

    // The widest scope held wins. A user who is globally scoped for one role
    // and territory-scoped for another is effectively global — narrowing them
    // would silently remove access their global role legitimately grants.
    const scopeType: ScopeType = hasGlobal
      ? 'GLOBAL'
      : hasTerritory
        ? 'TERRITORY'
        : hasDistributor
          ? 'DISTRIBUTOR'
          : // No assignments at all. Not 'GLOBAL' — an unassigned user must see
            // nothing, and TERRITORY with an empty id list produces exactly that.
            'TERRITORY';

    return {
      userId,
      permissions: [...permissions].sort() as Permission[],
      scopeType,
      territoryIds: [...territoryIds],
      distributorIds: [...distributorIds],
    };
  }

  /**
   * Drops a user's cached access.
   *
   * Must be called whenever a role assignment changes. Without it, a revoked
   * permission would keep working for up to the cache TTL.
   */
  async invalidate(userId: string): Promise<void> {
    await this.redis.del(CacheKeys.userAccess(userId), CacheKeys.userPermissions(userId));
  }

  /**
   * Drops every user's cached access.
   *
   * Used when a ROLE's permission set changes, which affects everyone holding
   * it. Finding exactly who that is costs a query; clearing the namespace is
   * cheaper and errs toward correctness.
   */
  async invalidateAll(): Promise<void> {
    const cleared = await this.redis.delByPattern('access:user:*');
    this.logger.info({ cleared }, 'Invalidated all cached access');
  }

  /** Fingerprint embedded in access tokens so permission drift is detectable. */
  static permissionHash(access: EffectiveAccess): string {
    return TokenService.hashPermissions(access.permissions);
  }
}
