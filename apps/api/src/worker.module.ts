import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module';
import { CacheModule } from './infrastructure/cache/cache.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { LoggerModule } from './infrastructure/logging/logger.module';
import { MailModule } from './infrastructure/mail/mail.module';
import { OutboxDispatcherModule, OutboxModule } from './infrastructure/outbox/outbox.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { EmailProcessor } from './jobs/email.processor';
import { MaintenanceProcessor } from './jobs/maintenance.processor';

/**
 * Worker composition root.
 *
 * Deliberately excludes HTTP concerns — no controllers, no guards, no
 * throttler. It shares every infrastructure module with the API so a job and a
 * request see identical database, cache, and mail behaviour.
 */
@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    DatabaseModule,
    CacheModule,
    QueueModule,
    StorageModule,
    MailModule,
    OutboxModule,
    OutboxDispatcherModule,
    ScheduleModule.forRoot(),
  ],
  providers: [EmailProcessor, MaintenanceProcessor],
})
export class WorkerModule {}
