import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';

/**
 * Redis access for caching, rate limiting, and session lookups.
 *
 * Redis is a soft dependency by design (docs/07-integrations.md §7): a cache
 * miss falls through to Postgres and the request still succeeds. Every method
 * here therefore degrades rather than throws — an outage makes the system
 * slower, never wrong.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client!: Redis;
  private available = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RedisService.name);
  }

  onModuleInit(): void {
    this.client = new Redis(this.config.redis.url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      // Backoff rather than a tight reconnect loop against a down server.
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });

    this.client.on('ready', () => {
      this.available = true;
      this.logger.info('Redis connected');
    });
    this.client.on('error', (error) => {
      this.available = false;
      this.logger.error({ err: error }, 'Redis error');
    });
    this.client.on('close', () => {
      this.available = false;
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => this.client?.disconnect());
  }

  /** The raw client, for BullMQ and anything needing full Redis semantics. */
  get raw(): Redis {
    return this.client;
  }

  get isAvailable(): boolean {
    return this.available;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  // ── Cache ─────────────────────────────────────────────────────────────────

  async get<T>(key: string): Promise<T | null> {
    if (!this.available) return null;
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (error) {
      this.logger.warn({ err: error, key }, 'Cache read failed; falling through');
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.available) return;
    try {
      const payload = JSON.stringify(value);
      const ttl = ttlSeconds ?? this.config.cache.defaultTtl;
      if (ttl > 0) await this.client.set(key, payload, 'EX', ttl);
      else await this.client.set(key, payload);
    } catch (error) {
      this.logger.warn({ err: error, key }, 'Cache write failed; continuing');
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (!this.available || keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch (error) {
      this.logger.warn({ err: error, keys }, 'Cache delete failed');
    }
  }

  /**
   * Invalidates by pattern using SCAN, never KEYS.
   *
   * `KEYS *` blocks the entire Redis event loop while it walks the keyspace —
   * on a production instance that is a stall every client feels.
   */
  async delByPattern(pattern: string): Promise<number> {
    if (!this.available) return 0;
    let cursor = '0';
    let removed = 0;
    try {
      do {
        const [next, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (batch.length) {
          await this.client.del(...batch);
          removed += batch.length;
        }
      } while (cursor !== '0');
    } catch (error) {
      this.logger.warn({ err: error, pattern }, 'Pattern invalidation failed');
    }
    return removed;
  }

  /** Read-through cache. On Redis failure the factory still runs. */
  async remember<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const value = await factory();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  // ── Counters (rate limiting, lockouts) ────────────────────────────────────

  /** Increments and returns the running count with its TTL applied on first hit. */
  async increment(key: string, ttlSeconds: number): Promise<number> {
    if (!this.available) return 0;
    try {
      const results = await this.client.multi().incr(key).expire(key, ttlSeconds, 'NX').exec();
      const value = results?.[0]?.[1];
      return typeof value === 'number' ? value : 0;
    } catch (error) {
      this.logger.warn({ err: error, key }, 'Counter increment failed');
      // Failing open is correct here: Redis being down must not lock every
      // user out of logging in. The per-account DB lockout still applies.
      return 0;
    }
  }

  /**
   * Best-effort distributed lock. Returns a release function, or null when the
   * lock is already held.
   */
  async acquireLock(key: string, ttlSeconds: number): Promise<(() => Promise<void>) | null> {
    if (!this.available) return null;
    const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      const acquired = await this.client.set(key, token, 'EX', ttlSeconds, 'NX');
      if (acquired !== 'OK') return null;

      return async () => {
        // Compare-and-delete so a lock whose TTL expired and was re-acquired by
        // another worker is never released by the previous holder.
        await this.client.eval(
          `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
          1,
          key,
          token,
        );
      };
    } catch (error) {
      this.logger.warn({ err: error, key }, 'Lock acquisition failed');
      return null;
    }
  }
}

/**
 * Central cache-key registry.
 *
 * Keys are declared here rather than inlined so that every cached value has one
 * owner responsible for invalidating it. Ad-hoc key strings scattered through
 * services are how stale data outlives the change that should have cleared it.
 */
export const CacheKeys = {
  userPermissions: (userId: string) => `perm:user:${userId}`,
  userPermissionsPattern: () => 'perm:user:*',
  userAccess: (userId: string) => `access:user:${userId}`,
  systemSettings: (category: string) => `settings:${category}`,
  systemSettingsPattern: () => 'settings:*',
  featureFlags: () => 'flags:all',
  loginAttempts: (identifier: string) => `login:attempts:${identifier}`,
  dashboard: (scope: string) => `dashboard:${scope}`,
  dashboardPattern: () => 'dashboard:*',
} as const;
