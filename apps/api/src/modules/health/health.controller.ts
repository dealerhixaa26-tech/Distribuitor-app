import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AppConfigService } from '../../config/app-config.service';
import { JobHeartbeatService } from './job-heartbeat.service';

/**
 * Health endpoints for Docker healthchecks and external uptime monitoring.
 *
 * The split matters operationally:
 *   • /live  — is the process up? Never touches a dependency, so a database
 *              blip cannot cause Docker to kill and restart a healthy process.
 *   • /ready — can it actually serve traffic? Checks Postgres and Redis.
 *
 * Conflating the two is how a brief database hiccup turns into a restart loop.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    private readonly heartbeat: JobHeartbeatService,
  ) {}

  @Public()
  @RawResponse()
  @Get('live')
  @ApiOperation({ summary: 'Liveness — process is running' })
  live() {
    return {
      status: 'ok',
      service: this.config.app.name,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @RawResponse()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness — dependencies reachable' })
  async ready() {
    const [database, redis] = await Promise.all([this.prisma.ping(), this.redis.ping()]);

    // Postgres is the only hard dependency. Redis being down degrades the
    // system (cache misses fall through, queues pause) but requests still
    // succeed — so it must not fail readiness and pull the app out of service.
    // See docs/07-integrations.md §7.
    const checks = {
      database: database ? 'up' : 'down',
      redis: redis ? 'up' : 'degraded',
    };

    if (!database) {
      throw new ServiceUnavailableException({
        status: 'error',
        checks,
        timestamp: new Date().toISOString(),
      });
    }

    return {
      status: redis ? 'ok' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Is the WORKER alive?
   *
   * The gap this closes is the one that shaped Phase 10: the worker did not
   * boot for three phases and nothing noticed, because it serves no HTTP and a
   * dead worker emits an absence rather than an error. The worker writes a
   * heartbeat every 30 seconds; this reads it.
   *
   * ⚠️ Deliberately SEPARATE from `/ready`, and `/ready` does not consult it. A
   * dead worker must not pull the API out of service: orders can still be taken
   * while the outbox drains late. Conflating them would turn a background-job
   * outage into a customer-facing one.
   *
   * `503` when stale or never seen, so an external uptime check can watch this
   * URL directly. Excluded from the version prefix alongside `/live` and
   * `/ready` — a monitor should not need to know the API version to ask whether
   * the worker is alive, and two base paths in one monitoring config is how one
   * of them ends up unwatched.
   *
   * ⚠️ The detailed body below is FLATTENED by the problem+json exception
   * filter on the 503 path, exactly as `/ready`'s is. That is fine for a
   * monitor, which keys on the status code — but a human wants the numbers, and
   * for that there is `/health/jobs`, which returns 200 with the full picture
   * whatever the state. The two endpoints are a pair: one to alert on, one to
   * read.
   */
  @Public()
  @RawResponse()
  @Get('worker')
  @ApiOperation({ summary: 'Worker liveness, from its heartbeat' })
  async worker() {
    const heartbeat = await this.heartbeat.worker();

    if (!heartbeat) {
      // No row at all is not the same as a stale row: it means the worker has
      // never written one on this database — never deployed, or dying before it
      // can report. Exactly the ambiguity that hid the original bug.
      throw new ServiceUnavailableException({
        status: 'error',
        worker: 'never-seen',
        detail:
          'The worker has never recorded a heartbeat. It may have never started, or it may be ' +
          'failing during boot. Check that `pnpm dev` is running dev:worker.',
        timestamp: new Date().toISOString(),
      });
    }

    const body = {
      status: heartbeat.isStale ? 'error' : 'ok',
      worker: heartbeat.isStale ? 'stale' : 'alive',
      lastSeenAt: heartbeat.lastSeenAt.toISOString(),
      secondsSinceSeen: heartbeat.secondsSinceSeen,
      timestamp: new Date().toISOString(),
    };

    if (heartbeat.isStale) throw new ServiceUnavailableException(body);
    return body;
  }

  /**
   * Every scheduled job, when it last ran, and whether it worked.
   *
   * Answers "did the nightly reconciliation actually run last night?" with a
   * query instead of a grep through logs that have since rotated. `lastSeenAt`
   * and `lastSuccessAt` are separate because a job failing every hour is very
   * much alive and completely broken.
   */
  @Public()
  @RawResponse()
  @Get('jobs')
  @ApiOperation({ summary: 'Scheduled job health — last run, last success, staleness' })
  async jobs() {
    const signals = await this.heartbeat.list();
    const unhealthy = signals.filter((s) => s.isStale || s.status === 'FAILED');

    return {
      status: unhealthy.length === 0 ? 'ok' : 'degraded',
      unhealthyCount: unhealthy.length,
      jobs: signals.map((s) => ({
        name: s.name,
        status: s.status,
        isStale: s.isStale,
        lastSeenAt: s.lastSeenAt.toISOString(),
        lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
        secondsSinceSeen: s.secondsSinceSeen,
        lastDurationMs: s.lastDurationMs,
        lastError: s.lastError,
        runCount: s.runCount,
        failureCount: s.failureCount,
      })),
      timestamp: new Date().toISOString(),
    };
  }
}
