import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { RequestContextMiddleware } from './common/context/request-context.middleware';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { CacheModule } from './infrastructure/cache/cache.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { LoggerModule } from './infrastructure/logging/logger.module';
import { MailModule } from './infrastructure/mail/mail.module';
import { OutboxModule } from './infrastructure/outbox/outbox.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { DistributorsModule } from './modules/distributors/distributors.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { HealthModule } from './modules/health/health.module';
import { FinanceModule } from './modules/finance/finance.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { RolesModule } from './modules/roles/roles.module';
import { SalesModule } from './modules/sales/sales.module';
import { SettingsModule } from './modules/settings/settings.module';
import { TerritoriesModule } from './modules/territories/territories.module';
import { UsersModule } from './modules/users/users.module';

/**
 * API root module.
 *
 * Layer order matters here and is easy to get wrong: Nest runs
 * middleware → guards → interceptors → pipes → handler.
 *
 * The request context is established in MIDDLEWARE, because the auth guard
 * populates it and guards run before interceptors. Putting it in an interceptor
 * meant the guard wrote to a context that did not exist yet, leaving every
 * scoped query with no caller — see request-context.middleware.ts.
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

    ThrottlerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.throttle.ttl * 1000,
            limit: config.throttle.limit,
          },
        ],
      }),
    }),

    AuthModule,
    UsersModule,
    RolesModule,
    TerritoriesModule,
    SettingsModule,
    DocumentsModule,
    DistributorsModule,
    CatalogModule,
    PricingModule,
    InventoryModule,
    SalesModule,
    FinanceModule,
    AuditModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, including the health checks — a request without a
    // correlation id is a request nobody can trace.
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
