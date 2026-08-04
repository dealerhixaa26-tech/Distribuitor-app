import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { RequestContextStore, type RequestContext } from './request-context';

/**
 * Establishes the per-request ambient context.
 *
 * ── Why MIDDLEWARE and not an interceptor ──────────────────────────────────
 * NestJS runs middleware → guards → interceptors → pipes → handler.
 *
 * This started life as an interceptor, which put it AFTER the auth guard. The
 * guard would set `userId` and `access` on a context that did not exist yet
 * (a silent no-op), and the interceptor then created a fresh, empty one. Every
 * consumer downstream — audit attribution and, critically, the repository scope
 * filter — saw no caller at all.
 *
 * That stayed invisible while the scope extension was itself misconfigured. The
 * moment the extension started working, it correctly denied every scoped read,
 * because a request with no resolved access must see nothing.
 *
 * Middleware is the only layer that runs before guards, so it is the only
 * correct home for context that guards need to populate.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    // Honour an upstream id when Nginx or a client supplies one, so a trace
    // spans the whole hop chain rather than restarting at our edge.
    const incoming = request.headers['x-request-id'];
    const requestId = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();

    request.headers['x-request-id'] = requestId;
    response.setHeader('X-Request-Id', requestId);

    const context: RequestContext = {
      requestId,
      actorType: 'USER',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    };

    // `next()` must run INSIDE the store, or the guards and handlers that
    // follow are outside the async context and see nothing.
    RequestContextStore.run(context, () => next());
  }
}
