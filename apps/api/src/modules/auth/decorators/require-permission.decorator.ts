import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiForbiddenResponse, ApiOperation } from '@nestjs/swagger';
import type { Permission } from '@hixaa/contracts';

export const PERMISSIONS_KEY = 'hixaa:permissions';
export const PERMISSIONS_MODE_KEY = 'hixaa:permissions-mode';

export type PermissionMode = 'all' | 'any';

/**
 * Declares the permissions a route requires.
 *
 * Keys come from the `PERMISSIONS` constant in @hixaa/contracts, so a typo is a
 * compile error rather than a silently unenforced route — the failure mode of
 * string-literal permission checks.
 *
 *   @RequirePermission(PERMISSIONS.ORDER_APPROVE)
 *   @RequirePermission([PERMISSIONS.A, PERMISSIONS.B], 'any')
 */
export function RequirePermission(
  permissions: Permission | Permission[],
  mode: PermissionMode = 'all',
) {
  const list = Array.isArray(permissions) ? permissions : [permissions];

  return applyDecorators(
    SetMetadata(PERMISSIONS_KEY, list),
    SetMetadata(PERMISSIONS_MODE_KEY, mode),
    // Surfaced in the OpenAPI spec, so the requirement is documented rather
    // than something a client discovers by receiving a 403.
    ApiOperation({
      description: `Requires ${mode === 'any' ? 'any of' : 'all of'}: \`${list.join('`, `')}\``,
    }),
    ApiForbiddenResponse({ description: 'Caller lacks the required permission' }),
  );
}
