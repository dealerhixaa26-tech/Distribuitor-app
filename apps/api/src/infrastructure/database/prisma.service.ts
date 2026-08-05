import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';
import { scopeExtension } from './extensions/scope.extension';
import { softDeleteExtension } from './extensions/soft-delete.extension';

/**
 * Builds the guarded client.
 *
 * Order matters: soft-delete runs first so scope composes on top of an already
 * `deletedAt`-filtered query rather than the reverse.
 */
function createExtendedClient(base: PrismaClient) {
  return base.$extends(softDeleteExtension).$extends(scopeExtension);
}

export type ExtendedPrismaClient = ReturnType<typeof createExtendedClient>;

/**
 * The transaction-bound client handed to a `$transaction` callback.
 *
 * Derived from the extended client's own signature rather than hand-written, so
 * it stays correct as models are added and carries the soft-delete and scope
 * guarantees inside transactions too.
 */
export type PrismaTransaction = Parameters<
  Parameters<ExtendedPrismaClient['$transaction']>[0] extends (client: infer C) => unknown
    ? (client: C) => unknown
    : never
>[0];

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  /**
   * The raw client is private on purpose. Everything goes through `db`, which
   * carries the soft-delete and scope guarantees; exposing the unguarded client
   * would make those guarantees optional.
   */
  private readonly base: PrismaClient;

  /** The guarded client. Use this everywhere. */
  readonly db: ExtendedPrismaClient;

  constructor(
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PrismaService.name);

    this.base = new PrismaClient({
      datasources: { db: { url: config.database.url } },
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });

    this.registerLogging();
    this.db = createExtendedClient(this.base);
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect();

    // A per-session statement timeout is the backstop against a runaway query
    // holding a connection open indefinitely.
    const timeout = this.config.database.statementTimeoutMs;
    await this.base.$executeRawUnsafe(`SET statement_timeout = ${Number(timeout)}`);

    this.logger.info({ poolSize: this.config.database.poolSize }, 'Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
    this.logger.info('Database disconnected');
  }

  /**
   * Opens a business transaction. Services use this so that the business
   * write and its `OutboxEvent` commit or roll back together — see ADR-0005.
   */
  async transaction<T>(
    fn: (tx: PrismaTransaction) => Promise<T>,
    options?: { timeout?: number; maxWait?: number },
  ): Promise<T> {
    return this.db.$transaction((tx) => fn(tx), {
      timeout: options?.timeout ?? 15_000,
      maxWait: options?.maxWait ?? 5_000,
    });
  }

  /** Liveness probe for the health endpoint. */
  async ping(): Promise<boolean> {
    try {
      await this.base.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error({ err: error }, 'Database ping failed');
      return false;
    }
  }

  private registerLogging(): void {
    const slowMs = this.config.database.slowQueryMs;

    // Slow queries are the leading indicator of a missing index. Logging them
    // with their duration turns a future performance incident into a warning
    // someone can act on this week.
    this.base.$on('query' as never, (event: { query: string; duration: number }) => {
      if (event.duration >= slowMs) {
        this.recordSlowQuery(event.query, event.duration);
        this.logger.warn(
          { durationMs: event.duration, query: truncate(event.query) },
          'Slow query',
        );
      } else if (this.config.isDevelopment) {
        this.logger.trace({ durationMs: event.duration, query: truncate(event.query) }, 'Query');
      }
    });

    this.base.$on('warn' as never, (event: { message: string }) => {
      this.logger.warn({ prisma: event.message }, 'Prisma warning');
    });

    this.base.$on('error' as never, (event: { message: string }) => {
      this.logger.error({ prisma: event.message }, 'Prisma error');
    });
  }

  /**
   * Slow queries seen since the last digest, aggregated by SHAPE.
   *
   * ── Why aggregate rather than just log ──────────────────────────────────
   *
   * The slow-query warnings already existed and went into a log nobody reads
   * until something is already on fire. Their value is in the pattern: one
   * query at 2.2s is noise, the same query 400 times is a missing index.
   *
   * Aggregated by a normalised shape — literals stripped — so
   * `WHERE id = 'a'` and `WHERE id = 'b'` count as one problem rather than two
   * hundred. Bounded, because an unbounded map keyed by query text is a memory
   * leak wearing a monitoring costume.
   */
  private readonly slowQueries = new Map<string, { count: number; totalMs: number; maxMs: number }>();

  private static readonly MAX_TRACKED_SHAPES = 200;

  private recordSlowQuery(query: string, durationMs: number): void {
    const shape = normaliseQuery(query);
    const existing = this.slowQueries.get(shape);

    if (existing) {
      existing.count++;
      existing.totalMs += durationMs;
      existing.maxMs = Math.max(existing.maxMs, durationMs);
      return;
    }

    // Stop growing rather than evict cleverly: past this many distinct shapes
    // the digest is already telling you something is wrong.
    if (this.slowQueries.size >= PrismaService.MAX_TRACKED_SHAPES) return;
    this.slowQueries.set(shape, { count: 1, totalMs: durationMs, maxMs: durationMs });
  }

  /**
   * The worst offenders, and RESET.
   *
   * Reading drains, so each digest covers the period since the last one and two
   * consecutive digests never double-count.
   */
  drainSlowQueries(limit = 10): Array<{ shape: string; count: number; avgMs: number; maxMs: number }> {
    const rows = [...this.slowQueries.entries()]
      .map(([shape, stat]) => ({
        shape,
        count: stat.count,
        avgMs: Math.round(stat.totalMs / stat.count),
        maxMs: stat.maxMs,
      }))
      // By TOTAL time, not by count or by max: the query worth fixing is the one
      // costing the most time overall, which is rarely the single slowest one.
      .sort((a, b) => b.avgMs * b.count - a.avgMs * a.count)
      .slice(0, limit);

    this.slowQueries.clear();
    return rows;
  }

}

const truncate = (value: string, max = 500): string =>
  value.length > max ? `${value.slice(0, max)}…` : value;

/**
 * Collapses a query to its shape so the same statement with different literals
 * aggregates as one entry.
 */
function normaliseQuery(query: string): string {
  return query
    .replace(/\$\d+/g, '?')
    .replace(/'[^']*'/g, '?')
    .replace(/\b\d+\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
