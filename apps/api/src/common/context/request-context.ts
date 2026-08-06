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

  /**
   * Runs `fn` as a specific USER, with that user's resolved access.
   *
   * ── Why a background job would ever want this ──────────────────────────────
   *
   * A scheduled report is background work, but it must NOT run as SYSTEM. Since
   * ADR-0021 the system principal reads unscoped, which is right for a
   * reconciliation sweep over every warehouse and catastrophically wrong for a
   * report: a territory-scoped manager's monthly sales summary would be
   * computed over every territory and emailed to them.
   *
   * So a scheduled report runs as the person who scheduled it, seeing exactly
   * what they would see running it by hand. `actorType` is USER, so the scope
   * extension applies the predicate normally.
   *
   * ⚠️ DELIBERATELY `async`, and it AWAITS `fn` inside `storage.run`. This is
   * load-bearing, not style.
   *
   * Prisma operations are LAZY: `prisma.x.count()` builds a `PrismaPromise`
   * that does not execute until it is awaited. If this wrapper merely returned
   * `storage.run(ctx, fn)`, the context would exit the moment `fn` handed back
   * an unresolved promise, and the extension's `query` hook — where
   * `applyScope` runs — would fire OUTSIDE it. `applyScope` would then see no
   * ambient context at all, and its no-context branch returns the query
   * UNFILTERED.
   *
   * Measured, with west.manager (TERRITORY-scoped, 4 territories) against 2
   * distributors in different zones:
   *
   *   asUser(p, () => prisma.distributor.count())        → 2   UNSCOPED
   *   asUser(p, async () => prisma.distributor.count())  → 1   scoped
   *
   * Awaiting inside makes the callback shape irrelevant, so a caller cannot get
   * this wrong. The same hazard exists for `asSystem`, where it is harmless by
   * luck — losing the context there yields the unscoped read it wanted anyway.
   * Here it would email one manager every territory's data.
   */
  async asUser<T>(
    params: { userId: string; access: EffectiveAccess; label: string; requestId: string },
    fn: () => T | Promise<T>,
  ): Promise<T> {
    return storage.run(
      {
        requestId: params.requestId,
        userId: params.userId,
        actorType: 'USER',
        actorLabel: params.label,
        access: params.access,
      },
      async () => await fn(),
    );
  },
};
