import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module';
import { AuthModule } from './modules/auth/auth.module';
import { CacheModule } from './infrastructure/cache/cache.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { LoggerModule } from './infrastructure/logging/logger.module';
import { MailModule } from './infrastructure/mail/mail.module';
import { OutboxDispatcherModule, OutboxModule } from './infrastructure/outbox/outbox.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { InventoryProcessor } from './jobs/inventory.processor';
import { EmailProcessor } from './jobs/email.processor';
import { MaintenanceProcessor } from './jobs/maintenance.processor';
import { NotificationsProcessor } from './jobs/notifications.processor';
import { NotificationsService } from './modules/intelligence/notifications.service';
import { DocumentRendererModule } from './modules/documents/document-renderer.module';
import { InvoicePdfService } from './modules/finance/invoice-pdf.service';
import { QuotationPdfService } from './modules/sales/quotation-pdf.service';
import { SettingsModule } from './modules/settings/settings.module';

/**
 * Worker composition root.
 *
 * Deliberately excludes HTTP concerns — no controllers, no guards, no
 * throttler. It shares every infrastructure module with the API so a job and a
 * request see identical database, cache, and mail behaviour.
 *
 * ⚠️ THIS PROCESS DID NOT BOOT BETWEEN PHASE 6 AND PHASE 9.
 *
 * `InventoryModule` has imported `DistributorsModule` since Phase 6, and
 * `DistributorsService` takes `EncryptionService` — which `AuthModule` provides
 * and marks @Global. But @Global registers a provider only in a composition
 * that IMPORTS the module at least once, and this file never did. Every worker
 * start died with `UnknownDependenciesException`.
 *
 * Nothing noticed, because the API boots independently and the worker's only
 * symptom is work silently not happening. The OUTBOX DISPATCHER runs here, so
 * no domain event has ever actually been dispatched — Phase 7 recorded "the
 * quotation email is not delivered" and put it down to a missing handler, which
 * was only half the reason. Found in Phase 9 by starting the worker to test the
 * notifications processor.
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
    /*
     * Imported for `EncryptionService`, which `DistributorsService` needs — see
     * the note above. Providing it at this module's root does NOT work: Nest
     * resolves a service's dependencies in ITS OWN module's context, so the
     * provider has to reach `DistributorsModule`, and @Global is how it does.
     *
     * Safe despite `AuthModule` declaring a controller: the worker bootstraps
     * with `NestFactory.createApplicationContext`, which ignores controllers
     * entirely because there is no HTTP adapter to bind them to.
     */
    AuthModule,
    // Brings the reconciliation, reservation-expiry, and low-stock jobs.
    InventoryModule,
    /*
     * Supplies the shared pdfmake shell the two PDF services render into.
     *
     * ⚠️ `SettingsModule` must come with it. `DocumentRendererService` needs
     * `SettingsService` for the letterhead's company identity, and
     * `SettingsModule` is @Global — which, exactly as §4.22 of the handoff
     * records for `AuthModule`, registers NOTHING in a composition that has not
     * imported it at least once. The API imports it and works; the worker did
     * not, and adding the renderer alone killed the worker at boot with a
     * completely clean typecheck. The same trap, one phase later.
     */
    DocumentRendererModule,
    SettingsModule,
    ScheduleModule.forRoot(),
  ],
  providers: [
    EmailProcessor,
    MaintenanceProcessor,
    InventoryProcessor,
    NotificationsProcessor,
    /*
     * Provided DIRECTLY rather than by importing `IntelligenceModule`, which
     * would pull Finance → Sales into a process that needs neither. The service
     * depends only on Prisma, the clock and the logger.
     */
    NotificationsService,
    /*
     * Same reasoning, for the two PDF renderers the email processor attaches to
     * `quotation.sent` and `invoice.issued`. Both depend only on Prisma,
     * `DocumentRendererService` and the logger — importing SalesModule and
     * FinanceModule instead would drag the whole sales and finance graph into
     * the worker to reach two `render()` methods.
     */
    QuotationPdfService,
    InvoicePdfService,
  ],
})
export class WorkerModule {}
