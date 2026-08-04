import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AppConfigService } from '../../config/app-config.service';

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
}
