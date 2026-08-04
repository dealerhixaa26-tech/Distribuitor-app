import { type NextRequest, NextResponse } from 'next/server';
import { apiUrl, clearSessionCookies, cookieHeader, getAccessToken } from '@/lib/bff/session';

/**
 * Logout.
 *
 * Cookies are cleared locally regardless of what the API says: if the upstream
 * call fails, leaving the browser holding credentials it believes are valid is
 * the worse outcome. The server-side session is revoked on a best-effort basis.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = await getAccessToken();

  try {
    await fetch(apiUrl('auth/logout'), {
      method: 'POST',
      headers: {
        cookie: await cookieHeader(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'x-csrf-token': request.headers.get('x-csrf-token') ?? '',
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Deliberately swallowed — see above.
  }

  await clearSessionCookies();
  return new NextResponse(null, { status: 204 });
}
