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
}

const truncate = (value: string, max = 500): string =>
  value.length > max ? `${value.slice(0, max)}…` : value;
