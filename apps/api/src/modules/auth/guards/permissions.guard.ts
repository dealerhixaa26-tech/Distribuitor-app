import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@hixaa/contracts';
import { PermissionDeniedError } from '../../../common/errors/domain.error';
import {
  PERMISSIONS_KEY,
  PERMISSIONS_MODE_KEY,
  type PermissionMode,
} from '../decorators/require-permission.decorator';
import type { AuthedRequest } from './jwt-auth.guard';

/**
 * Enforces `@RequirePermission(...)`.
 *
 * This answers "may this user perform this action". It does NOT answer "on
 * which records" — that is the scope extension's job, applied at the repository
 * layer. Both must pass, and conflating them is the most common authorization
 * flaw in ERP systems. See docs/04-rbac-and-permissions.md §4.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No decorator means no permission requirement beyond authentication —
    // e.g. `/auth/me`, which any signed-in user may call.
    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const held = request.user?.access.permissions ?? [];

    const mode =
      this.reflector.getAllAndOverride<PermissionMode>(PERMISSIONS_MODE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'all';

    const granted =
      mode === 'any'
        ? required.some((permission) => held.includes(permission))
        : required.every((permission) => held.includes(permission));

    if (!granted) {
      // The missing permission is named in the error's context, which is
      // logged but never serialised to the caller — telling an attacker
      // precisely which grant they lack is free reconnaissance.
      throw new PermissionDeniedError(required.join(mode === 'any' ? ' | ' : ' & '));
    }

    return true;
  }
}
