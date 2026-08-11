import { cookies } from 'next/headers';

/**
 * Server-side session plumbing for the BFF.
 *
 * The browser holds three cookies, none of which expose a usable credential to
 * JavaScript:
 *
 *   hixaa_at    access token   HTTP-only  — attached as Bearer by the proxy
 *   hixaa_rt    refresh token  HTTP-only  — only ever sent to /auth/*
 *   csrf_token  CSRF value     readable   — echoed in a header (double-submit)
 *
 * The access token never reaches client JavaScript, so an XSS payload has
 * nothing to steal. That is the entire reason this BFF layer exists rather
 * than the browser calling NestJS directly. See docs/01-architecture.md §6.
 */

export const ACCESS_COOKIE = 'hixaa_at';
export const REFRESH_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'hixaa_rt';
export const CSRF_COOKIE = 'csrf_token';

/**
 * A presence marker, and nothing else.
 *
 * The route middleware asks one question — "is there a session?" — and its
 * fallback to the refresh cookie could never answer it: `hixaa_rt` is scoped to
 * `/…/auth`, so a request for `/orders/123` does not carry it. The access
 * cookie lives ~15 minutes, so every navigation after that redirected to
 * `/login` while a perfectly good 7-day refresh token sat in the browser.
 *
 * Same shape of defect as ADR-0026: a check reading a cookie the request never
 * sends. The fix is a marker at `Path=/` that carries NO credential — it holds
 * the literal `1` — so widening its scope widens nothing worth stealing. It
 * expires exactly with the refresh token it stands in for.
 */
export const SESSION_MARKER_COOKIE = 'hixaa_session';

export const API_ORIGIN = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
export const API_PREFIX = process.env.API_PREFIX ?? 'api/v1';

export const apiUrl = (path: string): string =>
  `${API_ORIGIN}/${API_PREFIX}/${path.replace(/^\//, '')}`;

export async function getAccessToken(): Promise<string | undefined> {
  return (await cookies()).get(ACCESS_COOKIE)?.value;
}

/**
 * Stores the access token in an HTTP-only cookie.
 *
 * Its Max-Age intentionally slightly exceeds the token's own lifetime, so the
 * proxy sees an expired token and can refresh it — rather than seeing no
 * cookie at all and treating the user as signed out.
 */
export async function setAccessToken(token: string, expiresInSeconds: number): Promise<void> {
  (await cookies()).set(ACCESS_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: expiresInSeconds + 60,
  });
}

/**
 * Mirrors the refresh cookie's lifetime onto the marker.
 *
 * Read from the upstream `Set-Cookie` rather than hardcoded, so "remember me
 * for 30 days" and the ordinary 7-day session each get a marker that expires
 * with them. A marker outliving its session would send someone to a dashboard
 * that immediately 401s — the opposite failure, and just as annoying.
 */
export async function setSessionMarker(from: Headers): Promise<void> {
  const raw = typeof from.getSetCookie === 'function' ? from.getSetCookie() : [];
  const refresh = raw.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE}=`));
  if (!refresh) return;

  const maxAge = Number(/Max-Age=(\d+)/i.exec(refresh)?.[1] ?? 0);
  if (!maxAge) return;

  (await cookies()).set(SESSION_MARKER_COOKIE, '1', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
}

export async function clearSessionCookies(): Promise<void> {
  const store = await cookies();
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
  store.delete(CSRF_COOKIE);
  store.delete(SESSION_MARKER_COOKIE);
}

/** Serialises the browser's cookies for forwarding upstream. */
export async function cookieHeader(): Promise<string> {
  return (await cookies())
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

/**
 * Copies upstream `Set-Cookie` headers onto our response.
 *
 * NestJS scopes the refresh cookie to `/api/v1/auth`, but the browser talks to
 * `/api/bff/auth`, so the path must be rewritten or the browser would never
 * send it back.
 */
export function forwardSetCookies(from: Headers, to: Headers): void {
  const raw = typeof from.getSetCookie === 'function' ? from.getSetCookie() : [];
  for (const cookie of raw) {
    to.append('set-cookie', cookie.replace(/Path=\/api\/v1\/auth/i, 'Path=/api/bff/auth'));
  }
}
