import { Injectable } from '@nestjs/common';
import { Money, type CreateSalesTargetDto } from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import { AlreadyExistsError, NotFoundError } from '../../common/errors/domain.error';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/**
 * Sales targets, and achievement against them.
 *
 * ── Achievement is judged against ELAPSED time, not against the whole period ──
 * 40% of an annual target in April is not "behind"; it is spectacular. A status
 * computed from `achieved / target` alone marks every target BEHIND until
 * December, and a status that is wrong eleven months of the year is one nobody
 * looks at.
 *
 * So `status` compares achievement against how far through the period we are.
 * The raw percentage is still returned — the judgement is a convenience, not a
 * replacement for the number.
 */
@Injectable()
export class TargetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TargetsService.name);
  }

  async create(dto: CreateSalesTargetDto, actorId: string) {
    const dimension = dto.territoryId
      ? { territoryId: dto.territoryId }
      : dto.distributorId
        ? { distributorId: dto.distributorId }
        : { productId: dto.productId };

    // Mirrors the partial unique indexes in migration 0013. Caught here so the
    // caller gets a sentence rather than a constraint name.
    const existing = await this.prisma.db.salesTarget.findFirst({
      where: {
        ...dimension,
        periodStart: new Date(`${dto.periodStart}T00:00:00.000Z`),
        periodEnd: new Date(`${dto.periodEnd}T00:00:00.000Z`),
      },
      select: { id: true },
    });
    if (existing) {
      throw new AlreadyExistsError(
        'sales target',
        'period',
        `${dto.periodStart} — ${dto.periodEnd}`,
      );
    }

    const created = await this.prisma.transaction(async (tx) => {
      const target = await tx.salesTarget.create({
        data: {
          periodType: dto.periodType,
          periodStart: new Date(`${dto.periodStart}T00:00:00.000Z`),
          periodEnd: new Date(`${dto.periodEnd}T00:00:00.000Z`),
          territoryId: dto.territoryId ?? null,
          distributorId: dto.distributorId ?? null,
          productId: dto.productId ?? null,
          targetAmount: dto.targetAmount,
          targetQuantity: dto.targetQuantity ?? null,
          notes: dto.notes ?? null,
          createdById: actorId,
        },
      });

      await this.audit.record(tx, {
        action: 'target.created',
        entityType: 'SalesTarget',
        entityId: target.id,
        after: { ...dimension, period: `${dto.periodStart}/${dto.periodEnd}`, amount: dto.targetAmount },
        metadata: { actorId },
      });

      return target;
    });

    return this.toAchievement(created);
  }

  async list(query: { from?: string; to?: string }) {
    const where: Prisma.SalesTargetWhereInput = {
      ...(query.from ? { periodEnd: { gte: new Date(`${query.from}T00:00:00.000Z`) } } : {}),
      ...(query.to ? { periodStart: { lte: new Date(`${query.to}T00:00:00.000Z`) } } : {}),
    };

    const targets = await this.prisma.db.salesTarget.findMany({
      where,
      orderBy: [{ periodStart: 'desc' }],
      take: 200,
    });

    return Promise.all(targets.map((target) => this.toAchievement(target)));
  }

  async remove(id: string, actorId: string): Promise<void> {
    const target = await this.prisma.db.salesTarget.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!target) throw new NotFoundError('SalesTarget', id);

    await this.prisma.transaction(async (tx) => {
      await tx.salesTarget.softDelete({ id });
      await this.audit.record(tx, {
        action: 'target.deleted',
        entityType: 'SalesTarget',
        entityId: id,
        metadata: { actorId },
      });
    });
  }

  /**
   * What was actually achieved against one target.
   *
   * Achievement is measured on ORDER value rather than invoiced value: a sales
   * target is about winning business, and an order won in March that is
   * invoiced in April belongs to March's target. Revenue recognition is a
   * different question, answered by the finance screens.
   */
  private async toAchievement(target: {
    id: string;
    territoryId: string | null;
    distributorId: string | null;
    productId: string | null;
    periodStart: Date;
    periodEnd: Date;
    targetAmount: Prisma.Decimal;
  }) {
    const window = { gte: target.periodStart, lte: target.periodEnd };
    // Not `as const` on the array: Prisma's `Exact<>` rejects a readonly tuple
    // where it wants a mutable OrderStatus[].
    const liveOrders: Prisma.OrderWhereInput = {
      type: 'PRIMARY',
      status: { notIn: ['DRAFT', 'CANCELLED', 'REJECTED'] },
      orderDate: window,
    };

    let achieved = Money.zero();
    let dimension: 'TERRITORY' | 'DISTRIBUTOR' | 'PRODUCT';
    let dimensionId: string;
    let label: string;

    if (target.distributorId) {
      dimension = 'DISTRIBUTOR';
      dimensionId = target.distributorId;
      const [result, distributor] = await Promise.all([
        this.prisma.db.order.aggregate({
          where: { ...liveOrders, distributorId: target.distributorId },
          _sum: { taxableValue: true },
        }),
        this.prisma.db.distributor.findFirst({
          where: { id: target.distributorId },
          select: { legalName: true },
        }),
      ]);
      achieved = Money.of(result._sum.taxableValue?.toFixed(4) ?? '0');
      label = distributor?.legalName ?? 'Unknown distributor';
    } else if (target.productId) {
      dimension = 'PRODUCT';
      dimensionId = target.productId;
      const [result, product] = await Promise.all([
        this.prisma.db.orderLine.aggregate({
          where: { productId: target.productId, order: liveOrders },
          _sum: { taxableValue: true },
        }),
        this.prisma.db.product.findFirst({
          where: { id: target.productId },
          select: { name: true },
        }),
      ]);
      achieved = Money.of(result._sum.taxableValue?.toFixed(4) ?? '0');
      label = product?.name ?? 'Unknown product';
    } else {
      dimension = 'TERRITORY';
      dimensionId = target.territoryId ?? '';
      const [result, territory] = await Promise.all([
        this.prisma.db.order.aggregate({
          where: {
            ...liveOrders,
            OR: [
              { distributor: { territoryId: target.territoryId } },
              { customer: { territoryId: target.territoryId } },
            ],
          },
          _sum: { taxableValue: true },
        }),
        this.prisma.db.territory.findFirst({
          where: { id: target.territoryId ?? '' },
          select: { name: true },
        }),
      ]);
      achieved = Money.of(result._sum.taxableValue?.toFixed(4) ?? '0');
      label = territory?.name ?? 'Unknown territory';
    }

    const targetAmount = Money.of(target.targetAmount.toFixed(4));
    const achievementPercent = targetAmount.isZero()
      ? null
      : achieved.multiply(100).divide(targetAmount.toString()).round(2);

    const elapsed = this.elapsedPercent(target.periodStart, target.periodEnd);

    return {
      targetId: target.id,
      dimension,
      dimensionId,
      dimensionLabel: label,
      periodStart: target.periodStart.toISOString().slice(0, 10),
      periodEnd: target.periodEnd.toISOString().slice(0, 10),
      targetAmount: targetAmount.toString(),
      achievedAmount: achieved.toString(),
      achievementPercent: achievementPercent?.toString() ?? null,
      periodElapsedPercent: elapsed.toString(),
      status: this.statusFor(achievementPercent, elapsed, target.periodEnd),
    };
  }

  private elapsedPercent(start: Date, end: Date): Money {
    const now = this.clock.now().getTime();
    const total = end.getTime() - start.getTime();
    if (total <= 0) return Money.of(100);
    const elapsed = Math.min(Math.max(now - start.getTime(), 0), total);
    return Money.of(elapsed).multiply(100).divide(total).round(2);
  }

  /**
   * The judgement, made against elapsed time.
   *
   * A closed period is judged absolutely — once it is over, "on track" has no
   * meaning and the only question is whether the target was met.
   */
  private statusFor(
    achievement: Money | null,
    elapsed: Money,
    periodEnd: Date,
  ): 'AHEAD' | 'ON_TRACK' | 'BEHIND' | 'MISSED' {
    if (!achievement) return 'BEHIND';

    const periodClosed = periodEnd.getTime() < this.clock.now().getTime();
    if (periodClosed) return achievement.gte(100) ? 'AHEAD' : 'MISSED';

    // A 5-point band around the elapsed line, so a target sitting exactly on
    // pace does not flicker between AHEAD and BEHIND on every refresh.
    if (achievement.gte(elapsed.add(5))) return 'AHEAD';
    if (achievement.gte(elapsed.subtract(5))) return 'ON_TRACK';
    return 'BEHIND';
  }
}
