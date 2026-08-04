import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'hixaa:public';

/**
 * Marks a route as reachable without authentication.
 *
 * The global guard denies by default, so forgetting this decorator makes an
 * endpoint private — a safe failure. The inverse design (allow by default,
 * mark private) fails open, and eventually something ships unprotected.
 *
 * Every use is a deliberate, reviewable decision: login, password reset,
 * email verification, and health checks.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
