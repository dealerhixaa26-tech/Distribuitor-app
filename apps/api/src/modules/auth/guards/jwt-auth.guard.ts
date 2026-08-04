import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES, type EffectiveAccess } from '@hixaa/contracts';
import type { Request } from 'express';
import { RequestContextStore } from '../../../common/context/request-context';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { UnauthenticatedError } from '../../../common/errors/domain.error';
import { AccessService } from '../services/access.service';
import { SessionService } from '../services/session.service';
import { TokenService } from '../services/token.service';

/** Shape attached to `request.user` once authentication succeeds. */
export interface AuthenticatedUser {
  id: string;
  sessionId: string;
  access: EffectiveAccess;
}

export type AuthedRequest = Request & { user?: AuthenticatedUser };

/**
 * Global authentication guard — registered with `APP_GUARD`, so every route is
 * private unless it opts out with `@Public()`.
 *
 * Deny-by-default matters: forgetting the decorator makes an endpoint private,
 * which is a safe failure. The inverse design (public by default, mark private)
 * fails open, and eventually something ships unprotected.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = extractBearerToken(request);

    if (!token) {
      throw new UnauthenticatedError('Authentication required', ERROR_CODES.UNAUTHENTICATED);
    }

    let claims;
    try {
      claims = await this.tokens.verifyAccessToken(token);
    } catch (error) {
      const expired = error instanceof Error && error.name === 'TokenExpiredError';
      throw new UnauthenticatedError(
        expired ? 'Access token expired' : 'Invalid access token',
        expired ? ERROR_CODES.TOKEN_EXPIRED : ERROR_CODES.TOKEN_INVALID,
      );
    }

    // A valid signature is not enough. The session behind the token may have
    // been revoked — by a sign-out, a password reset, or reuse detection — and
    // that must take effect immediately rather than at token expiry.
    await this.sessions.assertActive(claims.sessionId);

    const access = await this.access.resolve(claims.sub);

    // The token carries a fingerprint of the permissions it was minted with.
    // A mismatch means the user's roles changed since, so the token is stale
    // and must be refreshed. This is what bounds a revoked permission's
    // lifetime to the access-token TTL instead of forever.
    if (claims.permHash !== AccessService.permissionHash(access)) {
      throw new UnauthenticatedError(
        'Your permissions have changed. Please refresh your session.',
        ERROR_CODES.TOKEN_EXPIRED,
      );
    }

    const user: AuthenticatedUser = { id: claims.sub, sessionId: claims.sessionId, access };
    request.user = user;

    // Publish into the ambient context so the audit service can attribute
    // writes and the scope extension can filter queries, without every method
    // signature carrying a userId.
    const ctx = RequestContextStore.get();
    if (ctx) {
      ctx.userId = user.id;
      ctx.actorType = 'USER';
      ctx.access = access;
    }

    return true;
  }
}

function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;

  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return undefined;
  return value;
}
