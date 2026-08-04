import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ERROR_CODES, type FieldError, type ProblemDetails, problemTypeUri } from '@hixaa/contracts';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';
import { type DomainError, RateLimitedError, isDomainError } from '../errors/domain.error';

/**
 * The single exit point for every error leaving the API.
 *
 * Guarantees:
 *   • One response shape — RFC 7807 — for every failure, everywhere.
 *   • Stack traces and internal messages never reach the client.
 *   • Every error carries the requestId that correlates it to a log line.
 */
@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request.headers['x-request-id'] as string) ?? request.id ?? undefined;

    const problem = this.toProblem(exception, request, requestId);

    // 5xx is our fault and gets the full exception. 4xx is the caller's and is
    // logged at warn without the stack, so genuine incidents stay visible.
    if (problem.status >= 500) {
      this.logger.error(
        { err: exception, requestId, path: request.url, method: request.method, problem },
        problem.detail,
      );
    } else {
      this.logger.warn(
        {
          requestId,
          path: request.url,
          method: request.method,
          code: problem.code,
          status: problem.status,
          context: isDomainError(exception) ? exception.context : undefined,
        },
        problem.detail,
      );
    }

    if (exception instanceof RateLimitedError) {
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }

    response
      .status(problem.status)
      .type('application/problem+json')
      .json(problem);
  }

  private toProblem(exception: unknown, request: Request, requestId?: string): ProblemDetails {
    /*
     * A wall-clock stamp on an error response, not business logic. Injecting a
     * clock into the global exception filter would buy no test value.
     */
    // eslint-disable-next-line no-restricted-syntax
    const base = { instance: request.url, requestId, timestamp: new Date().toISOString() };

    // ── Our own domain errors — the common, well-described case ─────────────
    if (isDomainError(exception)) {
      return {
        ...base,
        type: problemTypeUri(exception.code),
        title: titleFor(exception),
        status: exception.status,
        detail: exception.message,
        code: exception.code,
        ...(exception.fieldErrors ? { errors: exception.fieldErrors } : {}),
        ...(exception.publicExtensions ? { extensions: exception.publicExtensions } : {}),
      };
    }

    // ── Zod, when validation escapes the pipe ───────────────────────────────
    if (exception instanceof ZodError) {
      return {
        ...base,
        type: problemTypeUri(ERROR_CODES.VALIDATION_FAILED),
        title: 'Validation failed',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: 'One or more fields are invalid.',
        code: ERROR_CODES.VALIDATION_FAILED,
        errors: zodToFieldErrors(exception),
      };
    }

    // ── Prisma — translated so database internals never leak ────────────────
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return { ...base, ...this.fromPrisma(exception) };
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      // A malformed query is a bug on our side, not the caller's.
      return {
        ...base,
        type: problemTypeUri(ERROR_CODES.INTERNAL_ERROR),
        title: 'Internal server error',
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        detail: 'An unexpected error occurred.',
        code: ERROR_CODES.INTERNAL_ERROR,
      };
    }

    if (
      exception instanceof Prisma.PrismaClientInitializationError ||
      exception instanceof Prisma.PrismaClientRustPanicError
    ) {
      return {
        ...base,
        type: problemTypeUri(ERROR_CODES.SERVICE_UNAVAILABLE),
        title: 'Service unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: 'The service is temporarily unavailable. Please retry.',
        code: ERROR_CODES.SERVICE_UNAVAILABLE,
      };
    }

    // ── Nest's own HttpExceptions (guards, throttler, 404 routing) ──────────
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const detail =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);

      const code = codeForStatus(status);
      return {
        ...base,
        type: problemTypeUri(code),
        title: exception.name.replace(/Exception$/, '').replace(/([A-Z])/g, ' $1').trim(),
        status,
        detail: Array.isArray(detail) ? detail.join('; ') : detail,
        code,
      };
    }

    // ── Anything else is genuinely unexpected ───────────────────────────────
    return {
      ...base,
      type: problemTypeUri(ERROR_CODES.INTERNAL_ERROR),
      title: 'Internal server error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'An unexpected error occurred. The incident has been logged.',
      code: ERROR_CODES.INTERNAL_ERROR,
    };
  }

  private fromPrisma(
    error: Prisma.PrismaClientKnownRequestError,
  ): Pick<ProblemDetails, 'type' | 'title' | 'status' | 'detail' | 'code' | 'errors'> {
    switch (error.code) {
      case 'P2002': {
        // Unique constraint. Name the field, but never echo the value — it may
        // be a credential or another user's data.
        const target = (error.meta?.['target'] as string[] | string | undefined) ?? [];
        const fields = Array.isArray(target) ? target : [target];
        const errors: FieldError[] = fields.map((field) => ({
          field,
          code: ERROR_CODES.ALREADY_EXISTS,
          message: 'Already in use',
        }));
        return {
          type: problemTypeUri(ERROR_CODES.ALREADY_EXISTS),
          title: 'Already exists',
          status: HttpStatus.CONFLICT,
          detail: fields.length
            ? `A record with this ${fields.join(', ')} already exists.`
            : 'A record with these details already exists.',
          code: ERROR_CODES.ALREADY_EXISTS,
          errors,
        };
      }

      case 'P2025':
        return {
          type: problemTypeUri(ERROR_CODES.NOT_FOUND),
          title: 'Not found',
          status: HttpStatus.NOT_FOUND,
          detail: 'The requested record was not found.',
          code: ERROR_CODES.NOT_FOUND,
        };

      case 'P2003':
        return {
          type: problemTypeUri(ERROR_CODES.CONFLICT),
          title: 'Related record missing',
          status: HttpStatus.CONFLICT,
          detail: 'A referenced record does not exist.',
          code: ERROR_CODES.CONFLICT,
        };

      case 'P2014':
        return {
          type: problemTypeUri(ERROR_CODES.CONFLICT),
          title: 'Record in use',
          status: HttpStatus.CONFLICT,
          detail: 'This record is referenced elsewhere and cannot be removed.',
          code: ERROR_CODES.CONFLICT,
        };

      case 'P2034':
        // Write conflict / deadlock — genuinely retryable by the caller.
        return {
          type: problemTypeUri(ERROR_CODES.CONFLICT),
          title: 'Write conflict',
          status: HttpStatus.CONFLICT,
          detail: 'The record was modified concurrently. Please retry.',
          code: ERROR_CODES.CONFLICT,
        };

      default:
        return {
          type: problemTypeUri(ERROR_CODES.INTERNAL_ERROR),
          title: 'Internal server error',
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          detail: 'An unexpected database error occurred.',
          code: ERROR_CODES.INTERNAL_ERROR,
        };
    }
  }
}

/** `InsufficientStockError` → `Insufficient stock`. */
function titleFor(error: DomainError): string {
  return error.name
    .replace(/Error$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

export function zodToFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    // `lines.2.quantity` reads better to a frontend as `lines[2].quantity`.
    field: issue.path.reduce<string>(
      (acc, segment) =>
        typeof segment === 'number' ? `${acc}[${segment}]` : acc ? `${acc}.${segment}` : `${segment}`,
      '',
    ),
    code: issue.code.toUpperCase(),
    message: issue.message,
  }));
}

function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return ERROR_CODES.MALFORMED_REQUEST;
    case 401:
      return ERROR_CODES.UNAUTHENTICATED;
    case 403:
      return ERROR_CODES.PERMISSION_DENIED;
    case 404:
      return ERROR_CODES.NOT_FOUND;
    case 409:
      return ERROR_CODES.CONFLICT;
    case 422:
      return ERROR_CODES.VALIDATION_FAILED;
    case 429:
      return ERROR_CODES.RATE_LIMITED;
    case 503:
      return ERROR_CODES.SERVICE_UNAVAILABLE;
    default:
      return status >= 500 ? ERROR_CODES.INTERNAL_ERROR : ERROR_CODES.MALFORMED_REQUEST;
  }
}
