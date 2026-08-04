import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  listAuditLogsQuerySchema,
  type ListAuditLogsQuery,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { keysetWhere, toListResult } from '../../common/utils/pagination.util';
import { zodQuery } from '../../common/pipes/zod-validation.pipe';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';

/**
 * Audit log viewer.
 *
 * Read-only by construction: there is no write path here, and the database
 * trigger from migration 0002 rejects UPDATE and DELETE outright. Even a bug in
 * this module cannot alter history.
 */
@ApiTags('Audit')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission(PERMISSIONS.AUDITLOG_READ)
  @ApiOperation({
    summary: 'Search the audit log',
    description:
      'Cursor-paginated. The audit log is the fastest-growing table in the system, so ' +
      'offset pagination is not offered — deep offsets would scan millions of rows.',
  })
  async list(@Query(zodQuery(listAuditLogsQuerySchema)) query: ListAuditLogsQuery) {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.category ? { category: query.category } : {}),
      // `startsWith` supports prefix filters like `auth.` for a whole family
      // of actions, which is how someone actually investigates an incident.
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const cursorWhere = keysetWhere(query.cursor);

    const rows = await this.prisma.db.auditLog.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: {
        id: true,
        actorUserId: true,
        actorType: true,
        actorLabel: true,
        category: true,
        action: true,
        entityType: true,
        entityId: true,
        before: true,
        after: true,
        ipAddress: true,
        requestId: true,
        createdAt: true,
        actor: { select: { firstName: true, lastName: true, email: true } },
      },
    });

    const totalCount = query.includeTotal
      ? await this.prisma.db.auditLog.count({ where })
      : undefined;

    const result = toListResult(rows, query.limit, totalCount);

    return {
      ...result,
      data: result.data.map((entry) => ({
        id: entry.id,
        actorUserId: entry.actorUserId,
        actorName: entry.actor
          ? `${entry.actor.firstName} ${entry.actor.lastName}`
          : (entry.actorLabel ?? null),
        actorType: entry.actorType,
        category: entry.category,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: entry.before,
        after: entry.after,
        ipAddress: entry.ipAddress,
        requestId: entry.requestId,
        createdAt: entry.createdAt,
      })),
    };
  }

  @Get('actions')
  @RequirePermission(PERMISSIONS.AUDITLOG_READ)
  @ApiOperation({ summary: 'Distinct action names, for populating filter dropdowns' })
  async actions() {
    const rows = await this.prisma.db.auditLog.groupBy({
      by: ['action', 'category'],
      _count: { action: true },
      orderBy: { _count: { action: 'desc' } },
      take: 100,
    });

    return rows.map((row) => ({
      action: row.action,
      category: row.category,
      count: row._count.action,
    }));
  }
}
