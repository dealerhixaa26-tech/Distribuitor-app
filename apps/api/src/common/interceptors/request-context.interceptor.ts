import { randomUUID } from 'node:crypto';
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { RequestContextStore, type RequestContext } from '../context/request-context';

/**
 * Establishes the per-request ambient context and echoes the request id.
 *
 * Runs before guards populate `request.user`, so the context starts anonymous
 * and the auth guard fills in the actor. Everything downstream — audit
 * attribution, scope filtering, log correlation — reads from here.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: { id: string } }>();
    const response = http.getResponse<Response>();

    // Honour an upstream id when Nginx or a client supplies one, so a trace
    // spans the whole hop chain rather than restarting at our edge.
    const incoming = request.headers['x-request-id'];
    const requestId = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();

    request.headers['x-request-id'] = requestId;
    response.setHeader('X-Request-Id', requestId);

    const ctx: RequestContext = {
      requestId,
      actorType: 'USER',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    };

    return RequestContextStore.run(ctx, () => next.handle());
  }
}
