import { type NextRequest, NextResponse } from 'next/server';
import { apiUrl, forwardSetCookies, setAccessToken } from '@/lib/bff/session';

/**
 * Login, handled explicitly rather than by the generic proxy.
 *
 * The upstream response body carries the access token. Passing it through
 * unchanged would put a live credential into client JavaScript — exactly what
 * this BFF exists to prevent. So the token is stripped from the body and moved
 * into an HTTP-only cookie.
 *
 * Next.js matches this specific route ahead of `[...path]`.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(apiUrl('auth/login'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Forwarded so the API rate-limits and audits the real client IP
        // rather than this server's.
        'x-forwarded-for': request.headers.get('x-forwarded-for') ?? '',
        'user-agent': request.headers.get('user-agent') ?? '',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return NextResponse.json(
      {
        type: 'about:blank',
        title: 'Bad gateway',
        status: 502,
        detail: 'The API could not be reached. Please try again.',
        code: 'SERVICE_UNAVAILABLE',
      },
      { status: 502, headers: { 'content-type': 'application/problem+json' } },
    );
  }

  const payload = (await upstream.json().catch(() => null)) as {
    data?: { accessToken?: string; expiresIn?: number };
  } | null;

  const headers = new Headers({ 'content-type': 'application/json' });
  // Carries the refresh and CSRF cookies through, with the path rewritten for
  // the BFF's own route prefix.
  forwardSetCookies(upstream.headers, headers);

  if (!upstream.ok || !payload?.data?.accessToken) {
    return new NextResponse(JSON.stringify(payload ?? {}), {
      status: upstream.status,
      headers,
    });
  }

  await setAccessToken(payload.data.accessToken, payload.data.expiresIn ?? 900);

  // The token is deliberately absent from what the browser receives.
  const { accessToken: _accessToken, expiresIn: _expiresIn, ...safe } = payload.data;
  return new NextResponse(JSON.stringify({ data: safe }), { status: 200, headers });
}
