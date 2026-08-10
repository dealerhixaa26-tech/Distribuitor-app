import { createHmac, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@hixaa/contracts';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { UnauthenticatedError } from '../../../common/errors/domain.error';
import { AppConfigService } from '../../../config/app-config.service';

export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';

/** Safe methods do not change state, so CSRF does not apply to them. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF protection.
 *
 * The threat: the browser attaches our HTTP-only refresh cookie automatically,
 * so a hostile page could trigger a state-changing request on a signed-in
 * admin's behalf. `SameSite=Lax` blocks most of that, but it is a single
 * control with known gaps, and an ERP that can approve orders warrants two.
 *
 * The token is issued in a JS-READABLE cookie and must be echoed in a header.
 * A cross-origin attacker can cause the cookie to be sent but cannot read it to
 * construct the header — that asymmetry is the whole mechanism.
 *
 * The token is HMAC-signed so a forged value cannot be planted via a subdomain
 * cookie-injection.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;

    // Public endpoints (login, forgot-password) have no session cookie to
    // ride on, so there is nothing for CSRF to abuse. They are protected by
    // rate limiting instead.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // A pure bearer-token call — a server-to-server client or a mobile app —
    // carries no cookies, so it cannot be cross-site forged.
    //
    // A browser is recognised by the cookies it sends, NOT by one particular
    // cookie. Reading only the refresh cookie exempted every mutation the admin
    // UI makes: that cookie is deliberately scoped to `/…/auth`, so the browser
    // never sends it to /distributors, the BFF never forwards it, and this
    // guard returned before comparing anything. Measured, not assumed —
    // a forged header was accepted with a 201. See ADR-0026.
    const isBrowserSession =
      Boolean(request.cookies?.[this.config.auth.cookieName]) ||
      Boolean(request.cookies?.[CSRF_COOKIE]);
    if (!isBrowserSession) return true;

    const cookieToken = request.cookies?.[CSRF_COOKIE] as string | undefined;
    const headerToken = request.headers[CSRF_HEADER] as string | undefined;

    if (!cookieToken || !headerToken) {
      throw new UnauthenticatedError('Missing CSRF token', ERROR_CODES.CSRF_INVALID);
    }

    if (!CsrfGuard.constantTimeEqual(cookieToken, headerToken)) {
      throw new UnauthenticatedError('CSRF token mismatch', ERROR_CODES.CSRF_INVALID);
    }

    if (!this.verifySignature(cookieToken)) {
      throw new UnauthenticatedError('CSRF token is not valid', ERROR_CODES.CSRF_INVALID);
    }

    return true;
  }

  /** `<random>.<hmac>` — the signature binds the value to our secret. */
  static issue(secret: string, random: string): string {
    const signature = createHmac('sha256', secret).update(random).digest('base64url');
    return `${random}.${signature}`;
  }

  private verifySignature(token: string): boolean {
    const separator = token.lastIndexOf('.');
    if (separator <= 0) return false;

    const random = token.slice(0, separator);
    const expected = CsrfGuard.issue(this.config.auth.csrfSecret, random);
    return CsrfGuard.constantTimeEqual(token, expected);
  }

  private static constantTimeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }
}
