import {
  ERROR_CODES,
  type ErrorCode,
  type FieldError,
  type InvoiceIssueRefusal,
} from '@hixaa/contracts';

/**
 * Domain error hierarchy.
 *
 * Services throw these; they know nothing about HTTP. `AllExceptionsFilter`
 * translates them into RFC 7807 Problem Details at the edge. That separation is
 * what lets the same service back a REST controller today and a queue consumer
 * or GraphQL resolver later without change.
 */
export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly status: number;

  /** Safe to expose to the caller. Anything sensitive stays in `context`. */
  readonly fieldErrors?: FieldError[];
  /** Logged, never serialised to the client. */
  readonly context?: Record<string, unknown>;
  /**
   * Machine-readable detail the caller MAY see, surfaced as `extensions`.
   *
   * Subclasses opt in explicitly. Nothing lands here by accident, which is why
   * `context` can stay a free-for-all for logging.
   */
  readonly publicExtensions?: Record<string, unknown>;

  constructor(message: string, options?: { fieldErrors?: FieldError[]; context?: Record<string, unknown> }) {
    super(message);
    this.name = new.target.name;
    this.fieldErrors = options?.fieldErrors;
    this.context = options?.context;
    Error.captureStackTrace?.(this, new.target);
  }
}

// ── 4xx — client ────────────────────────────────────────────────────────────

export class ValidationError extends DomainError {
  readonly code = ERROR_CODES.VALIDATION_FAILED;
  readonly status = 422;

  constructor(message = 'The submitted data is invalid', fieldErrors?: FieldError[]) {
    super(message, { fieldErrors });
  }
}

/**
 * Also thrown when a record exists but is outside the caller's scope.
 *
 * Returning 404 rather than 403 in that case is deliberate: a 403 confirms the
 * record exists, which turns the API into an enumeration oracle for a user who
 * should not know about it at all. See docs/03-api-design.md §3.
 */
export class NotFoundError extends DomainError {
  readonly code = ERROR_CODES.NOT_FOUND;
  readonly status = 404;

  constructor(resource: string, identifier?: string) {
    super(identifier ? `${resource} "${identifier}" was not found` : `${resource} was not found`, {
      context: { resource, identifier },
    });
  }
}

export class AlreadyExistsError extends DomainError {
  readonly code = ERROR_CODES.ALREADY_EXISTS;
  readonly status = 409;

  constructor(resource: string, field: string, value: string) {
    super(`A ${resource} with ${field} "${value}" already exists`, {
      fieldErrors: [{ field, code: ERROR_CODES.ALREADY_EXISTS, message: 'Already in use' }],
      context: { resource, field },
    });
  }
}

export class ConflictError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.CONFLICT;
  readonly status = 409;
}

export class UnauthenticatedError extends DomainError {
  readonly code: ErrorCode;
  readonly status = 401;

  constructor(message = 'Authentication is required', code: ErrorCode = ERROR_CODES.UNAUTHENTICATED) {
    super(message);
    this.code = code;
  }
}

export class PermissionDeniedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.PERMISSION_DENIED;
  readonly status = 403;

  constructor(permission: string) {
    super('You do not have permission to perform this action', { context: { permission } });
  }
}

export class RateLimitedError extends DomainError {
  readonly code = ERROR_CODES.RATE_LIMITED;
  readonly status = 429;

  constructor(readonly retryAfterSeconds: number) {
    super('Too many requests. Please try again shortly.');
  }
}

// ── Domain-specific conflicts ───────────────────────────────────────────────

export class InvalidStateTransitionError extends DomainError {
  readonly code = ERROR_CODES.INVALID_STATE_TRANSITION;
  readonly status = 409;

  constructor(entity: string, from: string, to: string) {
    super(`A ${entity} cannot move from ${from} to ${to}`, { context: { entity, from, to } });
  }
}

export class InsufficientStockError extends DomainError {
  readonly code = ERROR_CODES.INSUFFICIENT_STOCK;
  readonly status = 409;

  constructor(warehouse: string, available: string, requested: string, field?: string) {
    super(`Warehouse ${warehouse} has ${available} available; ${requested} requested.`, {
      fieldErrors: field
        ? [{ field, code: ERROR_CODES.INSUFFICIENT_STOCK, message: `Only ${available} available` }]
        : undefined,
      context: { warehouse, available, requested },
    });
  }
}

export class CreditLimitExceededError extends DomainError {
  readonly code = ERROR_CODES.CREDIT_LIMIT_EXCEEDED;
  readonly status = 409;

  constructor(distributor: string, limit: string, exposure: string) {
    super(
      `This order would take ${distributor} past its credit limit of ${limit} ` +
        `(current exposure ${exposure}).`,
      { context: { distributor, limit, exposure } },
    );
  }
}

/**
 * No price could be resolved for a product.
 *
 * Deliberately an ERROR rather than a zero. A silently zero-priced line on a
 * tax invoice is a legal document giving goods away, and it is precisely the
 * bug that ships because only the happy path was tested. See ADR-0007 §5.
 */
export class PriceNotFoundError extends DomainError {
  readonly code = ERROR_CODES.PRICE_NOT_FOUND;
  readonly status = 409;

  constructor(sku: string, priceListCode: string, quantity: string) {
    super(
      `No price for "${sku}" in price list ${priceListCode} at quantity ${quantity}. ` +
        'Add a price-list entry before quoting this product.',
      { context: { sku, priceListCode, quantity } },
    );
  }
}

export class ProductNotAuthorizedError extends DomainError {
  readonly code = ERROR_CODES.PRODUCT_NOT_AUTHORIZED;
  readonly status = 409;

  constructor(sku: string, distributorCode: string) {
    super(
      `"${sku}" is not in ${distributorCode}'s authorized catalog.`,
      { context: { sku, distributorCode } },
    );
  }
}

export class ImmutableRecordError extends DomainError {
  readonly code = ERROR_CODES.INVOICE_IMMUTABLE;
  readonly status = 409;

  constructor(entity: string, remedy: string) {
    super(`An issued ${entity} cannot be modified. ${remedy}`, { context: { entity } });
  }
}

/**
 * An invoice issue was refused by one of the gates in docs/23 §5.1.
 *
 * Distinct from a plain `ValidationError` because the caller did nothing wrong:
 * the request is well-formed and the DOCUMENT is not yet fit to become a legal
 * instrument. `refusal` names which gate, so the frontend can route the user to
 * the screen that fixes it rather than showing prose and hoping.
 */
export class InvoiceIssueRefusedError extends DomainError {
  readonly code = ERROR_CODES.INVOICE_ISSUE_REFUSED;
  readonly status = 422;
  override readonly publicExtensions: Record<string, unknown>;

  constructor(
    readonly refusal: InvoiceIssueRefusal,
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message, { context: { refusal, ...context } });
    // The gate that fired is the whole point of this error type — without it
    // the caller has prose and has to guess which screen fixes the problem.
    this.publicExtensions = { refusal };
  }
}

export class SelfApprovalError extends DomainError {
  readonly code = ERROR_CODES.SELF_APPROVAL_FORBIDDEN;
  readonly status = 403;

  /**
   * `action` and `origin` are parameterised because the same control guards two
   * different acts with different vocabulary: an order is APPROVED by someone
   * who did not CREATE it, and a payment is VERIFIED by someone who did not
   * RECORD it. Hardcoding "approve/created" produced "You cannot approve a
   * payment you recorded you created" the first time this was reused.
   */
  constructor(entity: string, action = 'approve', origin = 'created') {
    super(`You cannot ${action} a ${entity} you ${origin}.`);
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly code = ERROR_CODES.IDEMPOTENCY_KEY_REUSED;
  readonly status = 409;

  constructor() {
    super(
      'This Idempotency-Key has already been used with a different request body. ' +
        'Use a new key for a new request.',
    );
  }
}

// ── 5xx — server ────────────────────────────────────────────────────────────

export class ServiceUnavailableError extends DomainError {
  readonly code = ERROR_CODES.SERVICE_UNAVAILABLE;
  readonly status = 503;

  constructor(dependency: string) {
    super(`A required service is temporarily unavailable. Please retry.`, {
      context: { dependency },
    });
  }
}

export class InternalError extends DomainError {
  readonly code = ERROR_CODES.INTERNAL_ERROR;
  readonly status = 500;

  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { context });
  }
}

export const isDomainError = (error: unknown): error is DomainError => error instanceof DomainError;
