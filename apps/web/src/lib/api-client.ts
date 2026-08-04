import type { ProblemDetails } from '@hixaa/contracts';

/**
 * API client.
 *
 * Browser requests go to the Next.js BFF (`/api/bff/...`), which holds the
 * HTTP-only refresh cookie and attaches the bearer token server-side. The
 * access token therefore never exists in JavaScript, which removes token theft
 * via XSS as a viable attack. See docs/01-architecture.md §6.
 */

/** A failed request, carrying the server's Problem Details intact. */
export class ApiError extends Error {
  constructor(
    readonly problem: ProblemDetails,
    readonly status: number,
  ) {
    super(problem.detail || problem.title);
    this.name = 'ApiError';
  }

  /** Stable machine-readable code — switch on this, never on the message. */
  get code(): string {
    return this.problem.code;
  }

  /** The correlation id to quote in a support request. */
  get requestId(): string | undefined {
    return this.problem.requestId;
  }

  /** Field errors keyed by path, ready to hand to React Hook Form. */
  get fieldErrors(): Record<string, string> {
    const output: Record<string, string> = {};
    for (const error of this.problem.errors ?? []) output[error.field] = error.message;
    return output;
  }

  get isValidation(): boolean {
    return this.status === 422 || this.status === 400;
  }
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
  /** 5xx and 429 are worth retrying; 4xx will fail identically every time. */
  get isRetryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  query?: Record<string, string | number | boolean | string[] | undefined | null>;
  /** Makes a retried money-moving POST safe. See docs/03-api-design.md §5. */
  idempotencyKey?: string;
}

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? '/api/bff';

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    // CSV for repeated values, matching the API's filter convention.
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/** Reads the double-submit CSRF cookie set by the BFF. */
function csrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.cookie
    .split('; ')
    .find((row) => row.startsWith('csrf_token='))
    ?.split('=')[1];
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, query, idempotencyKey, headers, ...rest } = options;
  const method = (rest.method ?? 'GET').toUpperCase();

  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');

  if (method !== 'GET' && method !== 'HEAD') {
    const token = csrfToken();
    if (token) requestHeaders.set('X-CSRF-Token', token);
  }
  if (idempotencyKey) requestHeaders.set('Idempotency-Key', idempotencyKey);

  const response = await fetch(buildUrl(path, query), {
    ...rest,
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? safeJson(text) : null;

  if (!response.ok) {
    throw new ApiError(toProblem(payload, response), response.status);
  }

  // Unwrap the `{ data }` envelope so callers work with the resource directly;
  // paginated responses keep `meta`, so those are returned whole.
  if (payload && typeof payload === 'object' && 'data' in payload) {
    const envelope = payload as { data: unknown; meta?: unknown };
    return (envelope.meta !== undefined ? envelope : envelope.data) as T;
  }

  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Normalises anything that is not a well-formed Problem Details response. */
function toProblem(payload: unknown, response: Response): ProblemDetails {
  if (payload && typeof payload === 'object' && 'code' in payload && 'status' in payload) {
    return payload as ProblemDetails;
  }
  return {
    type: 'about:blank',
    title: response.statusText || 'Request failed',
    status: response.status,
    detail:
      typeof payload === 'string' && payload
        ? payload
        : 'The server returned an unexpected response.',
    code: response.status >= 500 ? 'INTERNAL_ERROR' : 'MALFORMED_REQUEST',
    requestId: response.headers.get('X-Request-Id') ?? undefined,
  };
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'PUT', body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'DELETE' }),
};
