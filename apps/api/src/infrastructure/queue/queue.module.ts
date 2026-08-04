import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { QUEUE_NAMES } from '@hixaa/contracts';
import { AppConfigService } from '../../config/app-config.service';

/**
 * BullMQ wiring.
 *
 * Retry policy is defined once here and inherited by every job, so no processor
 * can accidentally ship without backoff. Exponential from 1 minute covers the
 * realistic failure modes — a brief SMTP outage, a Google Sheets 429, a
 * transient DNS failure — without hammering a service that is already
 * struggling.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        connection: {
          url: config.redis.url,
          // BullMQ requires this to be null: a blocking BRPOPLPUSH must not be
          // aborted by a per-request retry cap.
          maxRetriesPerRequest: null,
        },
        prefix: config.queue.prefix,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 60_000 },
          // Keep a window of history for debugging without unbounded growth.
          removeOnComplete: { age: 86_400, count: 1_000 },
          // Failed jobs are kept far longer — they are the evidence trail when
          // a customer says an email never arrived.
          removeOnFail: { age: 604_800 },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.EMAIL },
      { name: QUEUE_NAMES.NOTIFICATIONS },
      { name: QUEUE_NAMES.SHEETS_SYNC },
      { name: QUEUE_NAMES.REPORTS },
      { name: QUEUE_NAMES.MAINTENANCE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
