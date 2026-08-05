import { Global, Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { JobHeartbeatService } from './job-heartbeat.service';

/**
 * Health, and the heartbeat behind it.
 *
 * @Global because every scheduled job in the worker wraps itself in
 * `JobHeartbeatService.track()`, and those jobs live in several modules. The
 * alternative — importing this module into each of them — is the kind of step
 * that gets forgotten for the one job nobody thinks about, which is exactly the
 * job whose silence matters.
 *
 * ⚠️ @Global still requires the composition to IMPORT this module once. See
 * `HANDOFF` §4.22 — that assumption killed the worker twice.
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [JobHeartbeatService],
  exports: [JobHeartbeatService],
})
export class HealthModule {}
