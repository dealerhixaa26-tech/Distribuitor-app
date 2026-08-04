import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route gate.
 *
 * Checks only for the PRESENCE of a session cookie, never its validity — that
 * is the API's job, and a middleware that tried to verify a token would be
 * duplicating (and eventually disagreeing with) the real authorization layer.
 *
 * This is a redirect for user experience, not a security boundary: it keeps a
 * signed-out user from landing on an empty dashboard. Every actual protection
 * lives server-side in the guards and the repository scope filter.
 */

const ACCESS_COOKIE = 'hixaa_at';
const REFRESH_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'hixaa_rt';

/** Reachable without a session. */
const PUBLIC_ROUTES = [
  '/login',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/accept-invite',
];

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // An access cookie may have expired while the refresh cookie is still good;
  // the proxy will silently renew it, so either one counts as "has a session".
  const hasSession =
    request.cookies.has(ACCESS_COOKIE) || request.cookies.has(REFRESH_COOKIE);

  const isPublic = PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  if (!hasSession && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // Preserve where they were heading so sign-in returns them there.
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  // Already signed in and asking for the login page — send them onward.
  if (hasSession && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // The BFF is excluded deliberately: it must be able to return a 401 so the
  // client can react, rather than being redirected into an HTML page.
  matcher: ['/((?!api/bff|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp)$).*)'],
};
