import { createHash } from 'node:crypto';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import type { AuthedRequest } from '../../modules/auth/guards/jwt-auth.guard';
import { type Observable, from, of, switchMap, tap } from 'rxjs';
import { ClockService } from '../utils/clock.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { IDEMPOTENT_KEY } from '../decorators/idempotent.decorator';
import {
  ConflictError,
  IdempotencyConflictError,
  ValidationError,
} from '../errors/domain.error';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

/** `docs/03` §5. Long enough to outlive any client retry, short enough to purge. */
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Makes a retried money-moving request safe.
 *
 * The contract (`docs/03-api-design.md` §5): the key, the endpoint and a hash of
 * the request body are stored. A replay with the same key and the same body
 * returns the STORED response with `Idempotency-Replayed: true`. The same key
 * with a different body is a `409`. Keys expire after 24 hours.
 *
 * ## Why this is the OUTERMOST interceptor
 *
 * What gets stored has to be the response the client actually received —
 * enveloped, with Decimals already rendered as strings (ADR-0004). Interceptor
 * responses unwind outermost-last, so registering this ahead of
 * `TransformInterceptor` is what lets it see the final body. Storing the raw
 * handler return instead would replay a Decimal as a JSON number, and the
 * replay would disagree with the original by a rounding error — the exact
 * defect ADR-0004 exists to prevent, reachable only on the retry path.
 *
 * ## Concurrency
 *
 * The row is inserted BEFORE the handler runs, so the unique constraint on
 * `(key, userId, endpoint)` is the lock. A second request arriving while the
 * first is still in flight finds a row with no response yet and is refused
 * rather than allowed to run in parallel — two concurrent "approve order" calls
 * with one key must not both reach the service.
 *
 * ## A failed request does not burn the key
 *
 * The row is deleted when the handler throws. A payment refused for a bad
 * amount must be retryable with the same key once the amount is fixed;
 * remembering the failure would turn a client-side typo into a dead key and
 * push people towards generating a fresh one for every attempt, which defeats
 * the mechanism.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const required = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return next.handle();

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    const key = request.headers[IDEMPOTENCY_HEADER];
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new ValidationError('An Idempotency-Key header is required for this request.', [
        {
          field: 'Idempotency-Key',
          code: 'REQUIRED',
          message:
            'Generate a UUID per attempt and reuse it when retrying, so a retry cannot ' +
            'create a second record.',
        },
      ]);
    }
    if (key.length > 200) {
      throw new ValidationError('The Idempotency-Key header is too long.', [
        { field: 'Idempotency-Key', code: 'TOO_LONG', message: 'At most 200 characters.' },
      ]);
    }

    // Keys are scoped per user: one caller must never be able to read another's
    // stored response by guessing a key, and the unique index already includes
    // the user. An unauthenticated route cannot be idempotent in this scheme,
    // and none is marked.
    const userId = request.user?.id;
    if (!userId) return next.handle();

    const endpoint = `${request.method} ${request.route?.path ?? request.path}`;
    const requestHash = hashBody(request.body);
    const now = this.clock.now();

    return from(this.claim(key, userId, endpoint, requestHash, now)).pipe(
      switchMap((claim) => {
        if (claim.kind === 'replay') {
          response.setHeader(IDEMPOTENCY_REPLAYED_HEADER, 'true');
          response.status(claim.status);
          // `next.handle()` is deliberately NOT called: the point is that the
          // work does not happen twice. Nothing downstream runs, so the stored
          // body — already enveloped and serialised — is returned untouched.
          return of(claim.body);
        }

        return next.handle().pipe(
          tap({
            next: (body) => {
              void this.remember(claim.id, response.statusCode, body);
            },
            error: () => {
              void this.release(claim.id);
            },
          }),
        );
      }),
    );
  }

  /**
   * Takes the key, or reports what the existing holder means.
   *
   * The insert is the lock. Losing the race to the unique constraint is the
   * normal path for a retry, not an error.
   */
  private async claim(
    key: string,
    userId: string,
    endpoint: string,
    requestHash: string,
    now: Date,
  ): Promise<
    { kind: 'claimed'; id: string } | { kind: 'replay'; status: number; body: unknown }
  > {
    try {
      const created = await this.prisma.db.idempotencyKey.create({
        data: {
          key,
          userId,
          endpoint,
          requestHash,
          lockedAt: now,
          expiresAt: new Date(now.getTime() + KEY_TTL_MS),
        },
        select: { id: true },
      });
      return { kind: 'claimed', id: created.id };
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      ) {
        throw error;
      }
    }

    const existing = await this.prisma.db.idempotencyKey.findUnique({
      where: { key_userId_endpoint: { key, userId, endpoint } },
      select: { id: true, requestHash: true, responseStatus: true, responseBody: true, expiresAt: true },
    });

    // Expired between the failed insert and this read. Reclaim it rather than
    // refusing: the purge job is periodic, so an expired row is not a holder.
    if (!existing || existing.expiresAt <= now) {
      if (existing) await this.prisma.db.idempotencyKey.delete({ where: { id: existing.id } });
      return this.claim(key, userId, endpoint, requestHash, now);
    }

    if (existing.requestHash !== requestHash) throw new IdempotencyConflictError();

    if (existing.responseStatus === null) {
      throw new ConflictError(
        'A request with this Idempotency-Key is still in progress. Retry in a moment — ' +
          'the original will have completed, and you will receive its result.',
      );
    }

    return {
      kind: 'replay',
      status: existing.responseStatus,
      body: existing.responseBody,
    };
  }

  /** Stores the response the client received, so a replay returns exactly it. */
  private async remember(id: string, status: number, body: unknown): Promise<void> {
    try {
      await this.prisma.db.idempotencyKey.update({
        where: { id },
        data: {
          responseStatus: status,
          responseBody: (body ?? null) as Prisma.InputJsonValue,
          lockedAt: null,
        },
      });
    } catch {
      // The write succeeded; only the memo of it failed. Losing that costs a
      // duplicate on a retry, which is bad — but throwing here would turn a
      // completed order into an error the caller would retry, which is worse.
    }
  }

  /** Frees the key so the caller can fix the request and retry with it. */
  private async release(id: string): Promise<void> {
    try {
      await this.prisma.db.idempotencyKey.delete({ where: { id } });
    } catch {
      // Already gone, or the database is unreachable — the row expires anyway.
    }
  }
}

/**
 * A stable fingerprint of the request body.
 *
 * Object keys are sorted, so a client that serialises its JSON in a different
 * order on the retry is still recognised as the same request rather than
 * refused with a 409 it cannot act on.
 */
export function hashBody(body: unknown): string {
  return createHash('sha256').update(canonicalise(body)).digest('hex');
}

function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalise(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
