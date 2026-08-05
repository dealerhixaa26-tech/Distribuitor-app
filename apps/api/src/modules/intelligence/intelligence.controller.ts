import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  analyticsQuerySchema,
  createReportDefinitionSchema,
  createSalesTargetSchema,
  listReportRunsQuerySchema,
  runReportSchema,
  scheduleReportSchema,
  globalSearchQuerySchema,
  topNQuerySchema,
  trendQuerySchema,
  uuidSchema,
  type AnalyticsQuery,
  type CreateReportDefinitionDto,
  type CreateSalesTargetDto,
  type RunReportDto,
  type ScheduleReportDto,
  type GlobalSearchQuery,
  type TopNQuery,
  type TrendQuery,
} from '@hixaa/contracts';
import type { Response } from 'express';
import { NotFoundError } from '../../common/errors/domain.error';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { AnalyticsService } from './analytics.service';
import { NotificationsService } from './notifications.service';
import { ReportsService } from './reports.service';
import { SearchService } from './search.service';
import { TargetsService } from './targets.service';

/**
 * Analytics.
 *
 * Every route is guarded by `analytics:read`, and money fields inside the
 * responses are additionally gated on `analytics:read:financial` INSIDE the
 * service. Two levels, because the split is per-field rather than per-route: a
 * sales executive should see order counts and low stock on the same dashboard
 * where they cannot see margin.
 */
@ApiTags('Analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('kpis')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  @ApiOperation({
    summary: 'Headline figures with period-over-period deltas',
    description:
      'The comparison period is the same LENGTH immediately before the current one — on the 3rd ' +
      'of the month, three days against the previous month’s first three, not against a whole ' +
      'month. Money fields require analytics:read:financial and are ABSENT without it, never zero.',
  })
  async kpis(@Query(zodQuery(analyticsQuerySchema)) query: AnalyticsQuery) {
    return this.analytics.kpis(query);
  }

  @Get('sales-trend')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  async salesTrend(@Query(zodQuery(trendQuerySchema)) query: TrendQuery) {
    return this.analytics.salesTrend(query);
  }

  @Get('top-products')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  async topProducts(@Query(zodQuery(topNQuerySchema)) query: TopNQuery) {
    return this.analytics.topProducts(query);
  }

  @Get('top-distributors')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  async topDistributors(@Query(zodQuery(topNQuerySchema)) query: TopNQuery) {
    return this.analytics.topDistributors(query);
  }

  @Get('by-territory')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  async byTerritory(@Query(zodQuery(trendQuerySchema)) query: TrendQuery) {
    return this.analytics.byTerritory(query);
  }

  @Get('inventory-health')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  @ApiOperation({
    summary: 'Stock position — owned and channel reported SEPARATELY',
    description:
      '`ownedStockValue` excludes DISTRIBUTOR warehouses: those goods were sold at the sell-in ' +
      'invoice and counting them again overstates assets (ADR-0014 §4). `channelStockValue` ' +
      'reports them under their own name — a real question, but not an asset.',
  })
  async inventoryHealth() {
    return this.analytics.inventoryHealth();
  }

  @Get('receivables')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  @ApiOperation({
    summary: 'Aging summary — delegates to OutstandingService',
    description:
      'Not a second aging implementation. Two services computing "what is outstanding" would ' +
      'eventually disagree, and the dashboard is where that gets believed.',
  })
  async receivables() {
    return this.analytics.receivables();
  }

  @Get('activity')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  async activity(@Query('limit') limit?: string) {
    const parsed = Number(limit ?? 20);
    return this.analytics.activity(Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : 20);
  }
}

@ApiTags('Sales targets')
@Controller('targets')
export class TargetsController {
  constructor(private readonly targets: TargetsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  @ApiOperation({
    summary: 'Targets with achievement, judged against ELAPSED time',
    description:
      '40% of an annual target in April is not "behind". `status` compares achievement against ' +
      'how far through the period we are; the raw percentage is returned alongside it.',
  })
  async list(@Query('from') from?: string, @Query('to') to?: string) {
    return this.targets.list({ from, to });
  }

  @Post()
  @RequirePermission(PERMISSIONS.REPORT_CREATE)
  @ApiOperation({
    summary: 'Set a target for exactly one dimension',
    description:
      'A territory, a distributor, or a product — never two at once. Backed by a CHECK ' +
      'constraint, because a target measuring two things is ambiguous in a way that only ' +
      'surfaces when the achievement figure looks wrong.',
  })
  async create(
    @Body(zodBody(createSalesTargetSchema)) dto: CreateSalesTargetDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.targets.create(dto, actorId);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.REPORT_CREATE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.targets.remove(id, actorId);
  }
}

@ApiTags('Search')
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  @ApiOperation({
    summary: 'Cross-entity search for the ⌘K palette',
    description:
      'Scoped: results are bounded by the caller’s territory, so search cannot become the ' +
      'enumeration oracle that 404-not-403 exists to prevent. Products reuse the catalog’s ' +
      'full-text ranking; other entities match on identifiers, where substring is what someone ' +
      'typing "INV/2026" actually means.',
  })
  async globalSearch(@Query(zodQuery(globalSearchQuerySchema)) query: GlobalSearchQuery) {
    return this.search.search(query);
  }
}

// ── Reports ─────────────────────────────────────────────────────────────────

@ApiTags('Reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('catalogue')
  @RequirePermission(PERMISSIONS.REPORT_READ)
  @ApiOperation({
    summary: 'The report types, their parameters, and their columns',
    description:
      'A fixed catalogue, not a query builder (ADR-0020). Users save configured INSTANCES of ' +
      'these types; no user input ever becomes SQL, which is what lets every report inherit the ' +
      'scope extension instead of needing a DSL that injects scope predicates.',
  })
  catalogue() {
    return this.reports.catalogue();
  }

  @Get()
  @RequirePermission(PERMISSIONS.REPORT_READ)
  @ApiOperation({ summary: 'Saved definitions — your own, plus anything shared' })
  async list(@CurrentUser('id') actorId: string) {
    return this.reports.listDefinitions(actorId);
  }

  @Post()
  @RequirePermission(PERMISSIONS.REPORT_CREATE)
  @ApiOperation({ summary: 'Save a configured report' })
  async create(
    @Body(zodBody(createReportDefinitionSchema)) dto: CreateReportDefinitionDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.reports.createDefinition(dto, actorId);
  }

  @Post('run')
  @RequirePermission(PERMISSIONS.REPORT_RUN)
  @ApiOperation({
    summary: 'Run an ad-hoc report',
    description:
      'Returns inline under the row cap. A 500-row report should not require a job, a poll and ' +
      'an email — that is how people stop running reports.',
  })
  async runAdHoc(
    @Body(zodBody(runReportSchema)) dto: RunReportDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.reports.run(
      { type: dto.type, parameters: dto.parameters, format: dto.format },
      actorId,
    );
  }

  @Post(':id/run')
  @RequirePermission(PERMISSIONS.REPORT_RUN)
  async runSaved(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    const definitions = await this.reports.listDefinitions(actorId);
    const definition = definitions.find((entry) => entry.id === id);
    if (!definition) throw new NotFoundError('ReportDefinition', id);

    return this.reports.run(
      {
        type: definition.type as never,
        parameters: definition.parameters,
        format: definition.format as never,
        definitionId: id,
      },
      actorId,
    );
  }

  @Get(':id/download')
  @RequirePermission(PERMISSIONS.REPORT_EXPORT)
  @ApiOperation({ summary: 'Run a saved report and stream it as CSV' })
  async download(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
    @Res() response: Response,
  ): Promise<void> {
    const definitions = await this.reports.listDefinitions(actorId);
    const definition = definitions.find((entry) => entry.id === id);
    if (!definition) throw new NotFoundError('ReportDefinition', id);

    const result = await this.reports.run(
      {
        type: definition.type as never,
        parameters: definition.parameters,
        format: 'CSV',
        definitionId: id,
      },
      actorId,
    );

    const csv = this.reports.toCsv(result.columns, result.rows);
    const filename = `${definition.name.replace(/[^\w.-]/g, '-')}.csv`;
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // A BOM, so Excel on Windows reads UTF-8 rather than mangling every rupee
    // sign and every partner name with a non-ASCII character.
    response.end('﻿' + csv);
  }

  @Post(':id/schedule')
  @RequirePermission(PERMISSIONS.REPORT_SCHEDULE)
  @ApiOperation({
    summary: 'Schedule a saved report',
    description:
      'Emailed on the BUSINESS channel — the transport that reaches distributors and customers. ' +
      'An active schedule with no recipients is refused by a CHECK constraint: it would run ' +
      'forever and reach nobody, which looks like a working report until someone asks.',
  })
  async schedule(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(scheduleReportSchema)) dto: ScheduleReportDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.reports.schedule(id, dto, actorId);
  }

  @Get('runs')
  @RequirePermission(PERMISSIONS.REPORT_READ)
  async runs(@Query(zodQuery(listReportRunsQuerySchema)) query: { definitionId?: string; status?: string; limit: number }) {
    return this.reports.listRuns(query);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.REPORT_CREATE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.reports.removeDefinition(id, actorId);
  }
}

// ── Notifications ───────────────────────────────────────────────────────────

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.NOTIFICATION_READ)
  async list(
    @CurrentUser('id') userId: string,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit ?? 30);
    return this.notifications.list(userId, {
      unreadOnly: unreadOnly === 'true',
      limit: Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 30,
    });
  }

  @Get('unread-count')
  @RequirePermission(PERMISSIONS.NOTIFICATION_READ)
  @ApiOperation({
    summary: 'Unread count — polled, deliberately not an SSE stream',
    description:
      'docs/08 specifies SSE. That is a Phase 11 decision to take with the reverse-proxy ' +
      'configuration: a long-lived connection per user needs proxy_buffering off, heartbeats ' +
      'and reconnect handling, to deliver something whose value decays over minutes. One ' +
      'indexed count per 30 seconds has no failure mode worse than updating late (docs/25 §7).',
  })
  async unreadCount(@CurrentUser('id') userId: string) {
    return this.notifications.unreadCount(userId);
  }

  @Post(':id/read')
  @RequirePermission(PERMISSIONS.NOTIFICATION_READ)
  @ApiOperation({ summary: 'Mark one read. Idempotent — re-reading does not move the timestamp.' })
  async markRead(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.notifications.markRead(userId, id);
  }

  @Post('read-all')
  @RequirePermission(PERMISSIONS.NOTIFICATION_READ)
  async markAllRead(@CurrentUser('id') userId: string) {
    return this.notifications.markAllRead(userId);
  }
}
