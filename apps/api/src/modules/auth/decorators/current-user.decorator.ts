import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { UnauthenticatedError } from '../../../common/errors/domain.error';
import type { AuthedRequest, AuthenticatedUser } from '../guards/jwt-auth.guard';

/**
 * Injects the authenticated caller.
 *
 *   findAll(@CurrentUser() user: AuthenticatedUser)
 *   findAll(@CurrentUser('id') userId: string)
 *
 * Throws rather than returning undefined on an unauthenticated request: the
 * global guard should have rejected it already, so reaching here means a route
 * is misconfigured, and failing loudly is better than a handler silently
 * operating with no user.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const user = request.user;

    if (!user) {
      throw new UnauthenticatedError('No authenticated user on this request');
    }

    return field ? user[field] : user;
  },
);
