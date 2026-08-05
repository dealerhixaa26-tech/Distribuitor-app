import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { AnalyticsService } from './analytics.service';
import {
  AnalyticsController,
  NotificationsController,
  ReportsController,
  SearchController,
  TargetsController,
} from './intelligence.controller';
import { NotificationsService } from './notifications.service';
import { ReportsService } from './reports.service';
import { SearchService } from './search.service';
import { TargetsService } from './targets.service';

/**
 * Intelligence — the first phase that only READS.
 *
 * It imports `FinanceModule` for `OutstandingService`, which owns the aging
 * definition. That import is the whole point: the dashboard's receivables
 * figure is the Outstanding screen's figure, not a second aggregate that
 * happens to agree today.
 *
 * There is no `RedisModule` import because `CacheModule` is @Global — the
 * 5-minute analytics cache (ADR-0019) reads it directly.
 *
 * Note what is NOT here: no refresh worker, and no materialised-view service.
 * Both were specified in Phase 0 and dropped in Phase 9 after the aggregates
 * were measured. ADR-0019 carries the numbers and the conditions for
 * revisiting.
 */
@Module({
  imports: [FinanceModule],
  controllers: [
    AnalyticsController,
    TargetsController,
    SearchController,
    ReportsController,
    NotificationsController,
  ],
  providers: [AnalyticsService, TargetsService, SearchService, ReportsService, NotificationsService],
  // Exported so the worker's NotificationsProcessor can consume the queue that
  // `events.ts` has routed to since Phase 1 but nothing listened on.
  exports: [AnalyticsService, NotificationsService],
})
export class IntelligenceModule {}
