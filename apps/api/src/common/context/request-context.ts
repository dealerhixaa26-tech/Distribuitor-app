import { AsyncLocalStorage } from 'node:async_hooks';
import type { EffectiveAccess } from '@hixaa/contracts';

/**
 * Per-request ambient context, carried through async boundaries.
 *
 * Two consumers depend on this and neither can reasonably receive it as a
 * parameter:
 *
 *   • The audit Prisma extension, which must attribute a write to an actor
 *     without every repository method taking a `userId` argument.
 *   • The scope Prisma extension, which injects the caller's data boundary into
 *     every query. See ADR-0003.
 *
 * Background jobs run with `actorType: 'SYSTEM'` so an audit entry is never
 * anonymous — "who changed this?" always has an answer.
 */
export interface RequestContext {
  requestId: string;
  userId?: string;
  actorType: 'USER' | 'SYSTEM' | 'API_KEY';
  actorLabel?: string;
  ipAddress?: string;
  userAgent?: string;
  access?: EffectiveAccess;
  /** Set by `withoutScope()` to deliberately bypass scope filtering. */
  bypassScope?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const RequestContextStore = {
  run<T>(context: RequestContext, fn: () => T): T {
    return storage.run(context, fn);
  },

  get(): RequestContext | undefined {
    return storage.getStore();
  },

  /** The acting user, or undefined for system work. */
  userId(): string | undefined {
    return storage.getStore()?.userId;
  },

  requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },

  access(): EffectiveAccess | undefined {
    return storage.getStore()?.access;
  },

  /**
   * Runs `fn` with scope filtering disabled.
   *
   * Deliberately verbose and greppable: every call site is a place where a
   * developer asserted that reading across the whole dataset is correct, and is
   * a code-review checkpoint. Used by seeds, reconciliation jobs, and
   * cross-territory reports.
   */
  withoutScope<T>(fn: () => T): T {
    const current = storage.getStore();
    if (!current) return fn();
    return storage.run({ ...current, bypassScope: true }, fn);
  },

  /** Runs `fn` as the system principal — background jobs and schedulers. */
  asSystem<T>(label: string, requestId: string, fn: () => T): T {
    return storage.run({ requestId, actorType: 'SYSTEM', actorLabel: label }, fn);
  },
};
