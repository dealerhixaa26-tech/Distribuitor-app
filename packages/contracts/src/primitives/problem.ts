import { z } from 'zod';

/**
 * RFC 7807 Problem Details — the single error shape for the whole API.
 * See docs/03-api-design.md §3.
 */

/**
 * Stable, machine-readable error codes. The frontend switches on these; `detail`
 * is human text that may be reworded freely without breaking a client.
 */
export const ERROR_CODES = {
  // Validation & syntax
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  UNSUPPORTED_FILTER: 'UNSUPPORTED_FILTER',
  UNSUPPORTED_SORT: 'UNSUPPORTED_SORT',

  // Authentication
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_INVALID: 'MFA_INVALID',
  CSRF_INVALID: 'CSRF_INVALID',

  // Authorization
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  SEGREGATION_OF_DUTIES: 'SEGREGATION_OF_DUTIES',
  APPROVAL_CEILING_EXCEEDED: 'APPROVAL_CEILING_EXCEEDED',
  SELF_APPROVAL_FORBIDDEN: 'SELF_APPROVAL_FORBIDDEN',

  // Resource
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  CONFLICT: 'CONFLICT',
  GONE: 'GONE',

  // Domain — inventory
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  RESERVATION_FAILED: 'RESERVATION_FAILED',
  NEGATIVE_STOCK_BLOCKED: 'NEGATIVE_STOCK_BLOCKED',
  SERIAL_NOT_AVAILABLE: 'SERIAL_NOT_AVAILABLE',

  // Domain — sales & finance
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  CREDIT_LIMIT_EXCEEDED: 'CREDIT_LIMIT_EXCEEDED',
  DISTRIBUTOR_NOT_ACTIVE: 'DISTRIBUTOR_NOT_ACTIVE',
  PRODUCT_NOT_AUTHORIZED: 'PRODUCT_NOT_AUTHORIZED',
  PRICE_NOT_FOUND: 'PRICE_NOT_FOUND',
  INVOICE_IMMUTABLE: 'INVOICE_IMMUTABLE',
  OVER_ALLOCATION: 'OVER_ALLOCATION',
  NUMBER_SEQUENCE_EXHAUSTED: 'NUMBER_SEQUENCE_EXHAUSTED',

  // Files
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_TYPE_NOT_ALLOWED: 'FILE_TYPE_NOT_ALLOWED',
  FILE_SCAN_PENDING: 'FILE_SCAN_PENDING',
  FILE_INFECTED: 'FILE_INFECTED',

  // Infrastructure
  RATE_LIMITED: 'RATE_LIMITED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const fieldErrorSchema = z.object({
  /** Dotted path into the request body, e.g. `lines[2].quantity`. */
  field: z.string(),
  code: z.string(),
  message: z.string(),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;

export const problemDetailsSchema = z.object({
  /** URI identifying the problem type. */
  type: z.string(),
  /** Short, human-readable summary. Stable for a given `type`. */
  title: z.string(),
  status: z.number().int().min(100).max(599),
  /** Human-readable explanation specific to this occurrence. */
  detail: z.string(),
  /** URI of the specific occurrence — the request path. */
  instance: z.string().optional(),
  /** Correlates directly to a log line. The first thing support asks for. */
  requestId: z.string().optional(),
  /** Stable machine-readable code — switch on this, not on `detail`. */
  code: z.string(),
  /** Per-field detail for validation failures. */
  errors: z.array(fieldErrorSchema).optional(),
  timestamp: z.string().optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export const PROBLEM_BASE_URI = 'https://api.hixaa.com/problems';

/** `INSUFFICIENT_STOCK` → `https://api.hixaa.com/problems/insufficient-stock` */
export const problemTypeUri = (code: string): string =>
  `${PROBLEM_BASE_URI}/${code.toLowerCase().replace(/_/g, '-')}`;
