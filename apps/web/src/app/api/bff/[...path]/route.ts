import { type NextRequest, NextResponse } from 'next/server';
import {
  apiUrl,
  clearSessionCookies,
  cookieHeader,
  forwardSetCookies,
  getAccessToken,
  setAccessToken,
} from '@/lib/bff/session';

/**
 * Backend-for-frontend proxy.
 *
 * Attaches the access token from an HTTP-only cookie as a Bearer header, so the
 * token never exists in client JavaScript. On a 401 caused by an expired token,
 * it transparently refreshes and replays the request once — the user never sees
 * a spurious sign-out fifteen minutes into their session.
 *
 * See docs/01-architecture.md §6.
 */

/** Hop-by-hop headers must not cross a proxy boundary (RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'content-encoding',
]);

/** Auth routes manage their own cookies and must not be silently retried. */
const NO_RETRY = /^auth\/(login|refresh|logout|accept-invite|reset-password)/;

async function forward(
  request: NextRequest,
  path: string,
  body: string | undefined,
  accessToken: string | undefined,
): Promise<Response> {
  const target = new URL(apiUrl(path));
  target.search = request.nextUrl.search;

  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  }

  const cookies = await cookieHeader();
  if (cookies) headers.set('cookie', cookies);
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);

  return fetch(target, {
    method: request.method,
    headers,
    body,
    redirect: 'manual',
    // Long enough for a heavy report query, short enough that a hung upstream
    // does not pin a Next.js worker indefinitely.
    signal: AbortSignal.timeout(30_000),
  });
}

/** Exchanges the refresh cookie for a new access token. Returns it, or null. */
async function tryRefresh(): Promise<string | null> {
  try {
    const response = await fetch(apiUrl('auth/refresh'), {
      method: 'POST',
      headers: { cookie: await cookieHeader() },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as { data?: { accessToken?: string; expiresIn?: number } };
    const token = payload.data?.accessToken;
    if (!token) return null;

    await setAccessToken(token, payload.data?.expiresIn ?? 900);
    return token;
  } catch {
    return null;
  }
}

async function proxy(request: NextRequest, segments: string[]): Promise<NextResponse> {
  const path = segments.join('/');
  const body =
    request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();

  try {
    let accessToken = await getAccessToken();
    let upstream = await forward(request, path, body, accessToken);

    // One transparent refresh-and-replay. Excluded for auth routes, which
    // manage their own tokens and would loop.
    if (upstream.status === 401 && !NO_RETRY.test(path)) {
      const refreshed = await tryRefresh();
      if (refreshed) {
        accessToken = refreshed;
        upstream = await forward(request, path, body, accessToken);
      } else {
        // The refresh token is dead too — clear everything so the browser
        // stops replaying a session that no longer exists.
        await clearSessionCookies();
      }
    }

    const responseHeaders = new Headers();
    for (const [key, value] of upstream.headers.entries()) {
      if (!HOP_BY_HOP.has(key.toLowerCase()) && key.toLowerCase() !== 'set-cookie') {
        responseHeaders.set(key, value);
      }
    }
    forwardSetCookies(upstream.headers, responseHeaders);

    return new NextResponse(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    // Shaped as Problem Details so a proxy failure is handled by the client's
    // ApiError exactly like an upstream one.
    return NextResponse.json(
      {
        type: 'about:blank',
        title: timedOut ? 'Gateway timeout' : 'Bad gateway',
        status: timedOut ? 504 : 502,
        detail: timedOut
          ? 'The API did not respond in time.'
          : 'The API could not be reached. Please try again.',
        code: 'SERVICE_UNAVAILABLE',
      },
      { status: timedOut ? 504 : 502, headers: { 'content-type': 'application/problem+json' } },
    );
  }
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
export async function POST(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
export async function PUT(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
