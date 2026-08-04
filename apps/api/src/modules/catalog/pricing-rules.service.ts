import { Injectable } from '@nestjs/common';
import {
  DOMAIN_EVENTS,
  type CreateDiscountRuleDto,
  type CreateTaxRateDto,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import {
  AlreadyExistsError,
  ConflictError,
  NotFoundError,
} from '../../common/errors/domain.error';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';

/**
 * Discount rules and tax rates.
 *
 * Both are DATA that the pricing engine reads; neither contains logic. Grouped
 * in one service because they are the two tables an administrator edits when
 * commercial or statutory terms change, and both are small.
 */
@Injectable()
export class PricingRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PricingRulesService.name);
  }

  // ── Discount rules ────────────────────────────────────────────────────────

  async listDiscountRules(query: {
    scope?: string;
    targetId?: string;
    isActive?: boolean;
    activeOn?: string;
  }) {
    const where: Prisma.DiscountRuleWhereInput = {
      ...(query.scope ? { scope: query.scope as Prisma.EnumDiscountScopeFilter['equals'] } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    };

    if (query.activeOn) {
      const on = new Date(`${query.activeOn}T00:00:00.000Z`);
      where.validFrom = { lte: on };
      where.OR = [{ validTo: null }, { validTo: { gte: on } }];
    }

    const rows = await this.prisma.db.discountRule.findMany({
      where,
      orderBy: [{ priority: 'asc' }, { code: 'asc' }],
      select: DISCOUNT_SELECT,
    });

    return { data: await Promise.all(rows.map((row) => this.toDiscountSummary(row))) };
  }

  async createDiscountRule(dto: CreateDiscountRuleDto, actorId: string) {
    const existing = await this.prisma.db.discountRule.findFirst({
      where: { code: dto.code },
      select: { id: true },
    });
    if (existing) throw new AlreadyExistsError('discount rule', 'code', dto.code);

    // The target is polymorphic, so no FK can enforce it. Validating here is
    // the only place the scope tells us which table to look in — without this,
    // a typo'd id becomes a rule that silently never fires.
    if (dto.scope !== 'GLOBAL' && dto.targetId) {
      await this.assertTargetExists(dto.scope, dto.targetId);
    }

    const created = await this.prisma.transaction(async (tx) => {
      const rule = await tx.discountRule.create({
        data: {
          code: dto.code,
          name: dto.name,
          scope: dto.scope,
          targetId: dto.targetId ?? null,
          type: dto.type,
          value: dto.value,
          minQty: dto.minQty ?? null,
          minAmount: dto.minAmount ?? null,
          maxDiscountAmount: dto.maxDiscountAmount ?? null,
          priority: dto.priority,
          validFrom: new Date(`${dto.validFrom}T00:00:00.000Z`),
          validTo: dto.validTo ? new Date(`${dto.validTo}T00:00:00.000Z`) : null,
          isActive: dto.isActive,
          description: dto.description ?? null,
          createdById: actorId,
        },
        select: DISCOUNT_SELECT,
      });

      await this.audit.record(tx, {
        // A discount rule directly reduces revenue.
        category: 'SECURITY',
        action: 'discount.rule_created',
        entityType: 'DiscountRule',
        entityId: rule.id,
        after: {
          code: dto.code,
          scope: dto.scope,
          type: dto.type,
          value: dto.value,
          priority: dto.priority,
        },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.DISCOUNT_RULE_CHANGED,
        { type: 'DiscountRule', id: rule.id },
        { code: dto.code, action: 'created' },
      );

      return rule;
    });

    this.logger.warn({ ruleId: created.id, code: created.code, actorId }, 'Discount rule created');
    return this.toDiscountSummary(created);
  }

  async setDiscountRuleActive(id: string, isActive: boolean, actorId: string) {
    const rule = await this.prisma.db.discountRule.findFirst({
      where: { id },
      select: { id: true, code: true, isActive: true },
    });
    if (!rule) throw new NotFoundError('DiscountRule', id);

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.discountRule.update({
        where: { id },
        data: { isActive, updatedById: actorId },
        select: DISCOUNT_SELECT,
      });

      await this.audit.record(tx, {
        category: 'SECURITY',
        action: isActive ? 'discount.rule_activated' : 'discount.rule_deactivated',
        entityType: 'DiscountRule',
        entityId: id,
        before: { isActive: rule.isActive },
        after: { isActive },
      });

      return result;
    });

    return this.toDiscountSummary(updated);
  }

  async removeDiscountRule(id: string, actorId: string): Promise<void> {
    const rule = await this.prisma.db.discountRule.findFirst({
      where: { id },
      select: { id: true, code: true },
    });
    if (!rule) throw new NotFoundError('DiscountRule', id);

    await this.prisma.transaction(async (tx) => {
      await tx.discountRule.softDelete({ id });
      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'discount.rule_deleted',
        entityType: 'DiscountRule',
        entityId: id,
        before: { code: rule.code },
        metadata: { actorId },
      });
    });
  }

  // ── Tax rates ─────────────────────────────────────────────────────────────

  async listTaxRates(query: { hsnSacCode?: string; effectiveOn?: string }) {
    const where: Prisma.TaxRateWhereInput = {
      ...(query.hsnSacCode ? { hsnSacCode: query.hsnSacCode } : {}),
    };

    if (query.effectiveOn) {
      const on = new Date(`${query.effectiveOn}T00:00:00.000Z`);
      where.effectiveFrom = { lte: on };
      where.OR = [{ effectiveTo: null }, { effectiveTo: { gte: on } }];
    }

    const rows = await this.prisma.db.taxRate.findMany({
      where,
      orderBy: [{ hsnSacCode: 'asc' }, { effectiveFrom: 'desc' }],
      select: TAX_RATE_SELECT,
    });

    return { data: rows.map(toTaxRateSummary) };
  }

  /**
   * Adds a rate, superseding the open-ended one for the same code.
   *
   * A rate is NEVER edited (ADR-0008). Editing one would silently change the
   * tax on every historical invoice that resolves through it, which is exactly
   * what date-effectivity exists to prevent. The previous row's `effectiveTo`
   * is closed to the day before the new one starts.
   */
  async createTaxRate(dto: CreateTaxRateDto, actorId: string) {
    const effectiveFrom = new Date(`${dto.effectiveFrom}T00:00:00.000Z`);

    const duplicate = await this.prisma.db.taxRate.findFirst({
      where: { hsnSacCode: dto.hsnSacCode, effectiveFrom },
      select: { id: true },
    });
    if (duplicate) {
      throw new AlreadyExistsError('tax rate', 'effectiveFrom', dto.effectiveFrom);
    }

    const current = await this.prisma.db.taxRate.findFirst({
      where: { hsnSacCode: dto.hsnSacCode, effectiveTo: null },
      select: { id: true, gstRate: true, effectiveFrom: true },
    });

    if (current && current.effectiveFrom >= effectiveFrom) {
      throw new ConflictError(
        `A rate for ${dto.hsnSacCode} already takes effect on ` +
          `${current.effectiveFrom.toISOString().slice(0, 10)}. A superseding rate must start after it.`,
      );
    }

    const created = await this.prisma.transaction(async (tx) => {
      if (current) {
        // Closed the day before the new rate begins, so the two never overlap
        // and a lookup on any date resolves exactly one row.
        const closesOn = new Date(effectiveFrom);
        closesOn.setUTCDate(closesOn.getUTCDate() - 1);

        await tx.taxRate.update({
          where: { id: current.id },
          data: { effectiveTo: closesOn },
        });
      }

      const rate = await tx.taxRate.create({
        data: {
          hsnSacCode: dto.hsnSacCode,
          gstRate: dto.gstRate,
          cessRate: dto.cessRate,
          effectiveFrom,
          description: dto.description ?? null,
          createdById: actorId,
        },
        select: TAX_RATE_SELECT,
      });

      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'tax.rate_created',
        entityType: 'TaxRate',
        entityId: rate.id,
        before: current ? { gstRate: current.gstRate.toFixed(2) } : undefined,
        after: { hsnSacCode: dto.hsnSacCode, gstRate: dto.gstRate, effectiveFrom: dto.effectiveFrom },
      });

      if (current) {
        await this.outbox.emit(
          tx,
          DOMAIN_EVENTS.TAX_RATE_SUPERSEDED,
          { type: 'TaxRate', id: rate.id },
          {
            hsnSacCode: dto.hsnSacCode,
            from: current.gstRate.toFixed(2),
            to: String(dto.gstRate),
            effectiveFrom: dto.effectiveFrom,
          },
        );
      }

      return rate;
    });

    this.logger.warn(
      { hsnSacCode: dto.hsnSacCode, gstRate: dto.gstRate, effectiveFrom: dto.effectiveFrom },
      'Tax rate recorded',
    );
    return toTaxRateSummary(created);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async assertTargetExists(scope: string, targetId: string): Promise<void> {
    const exists = await (async () => {
      switch (scope) {
        case 'PRODUCT':
          return this.prisma.db.product.findFirst({ where: { id: targetId }, select: { id: true } });
        case 'CATEGORY':
          return this.prisma.db.category.findFirst({ where: { id: targetId }, select: { id: true } });
        case 'DISTRIBUTOR':
          return this.prisma.db.distributor.findFirst({ where: { id: targetId }, select: { id: true } });
        case 'PRICE_LIST':
          return this.prisma.db.priceList.findFirst({ where: { id: targetId }, select: { id: true } });
        default:
          return null;
      }
    })();

    if (!exists) {
      throw new NotFoundError(`${scope} target`, targetId);
    }
  }

  /** Resolves the polymorphic target to a display name for the list screen. */
  private async toDiscountSummary(row: DiscountRow) {
    let targetName: string | null = null;

    if (row.targetId) {
      switch (row.scope) {
        case 'PRODUCT': {
          const product = await this.prisma.db.product.findFirst({
            where: { id: row.targetId },
            select: { name: true },
          });
          targetName = product?.name ?? null;
          break;
        }
        case 'CATEGORY': {
          const category = await this.prisma.db.category.findFirst({
            where: { id: row.targetId },
            select: { name: true },
          });
          targetName = category?.name ?? null;
          break;
        }
        case 'DISTRIBUTOR': {
          const distributor = await this.prisma.db.distributor.findFirst({
            where: { id: row.targetId },
            select: { legalName: true },
          });
          targetName = distributor?.legalName ?? null;
          break;
        }
        case 'PRICE_LIST': {
          const priceList = await this.prisma.db.priceList.findFirst({
            where: { id: row.targetId },
            select: { name: true },
          });
          targetName = priceList?.name ?? null;
          break;
        }
        default:
          targetName = null;
      }
    }

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      scope: row.scope,
      targetId: row.targetId,
      targetName,
      type: row.type,
      value: row.value.toFixed(4),
      minQty: row.minQty ? row.minQty.toFixed(4) : null,
      minAmount: row.minAmount ? row.minAmount.toFixed(4) : null,
      maxDiscountAmount: row.maxDiscountAmount ? row.maxDiscountAmount.toFixed(4) : null,
      priority: row.priority,
      validFrom: row.validFrom.toISOString().slice(0, 10),
      validTo: row.validTo ? row.validTo.toISOString().slice(0, 10) : null,
      isActive: row.isActive,
      createdAt: row.createdAt,
    };
  }
}

const DISCOUNT_SELECT = {
  id: true,
  code: true,
  name: true,
  scope: true,
  targetId: true,
  type: true,
  value: true,
  minQty: true,
  minAmount: true,
  maxDiscountAmount: true,
  priority: true,
  validFrom: true,
  validTo: true,
  isActive: true,
  createdAt: true,
} satisfies Prisma.DiscountRuleSelect;

const TAX_RATE_SELECT = {
  id: true,
  hsnSacCode: true,
  gstRate: true,
  cessRate: true,
  description: true,
  effectiveFrom: true,
  effectiveTo: true,
  createdAt: true,
} satisfies Prisma.TaxRateSelect;

type DiscountRow = Prisma.DiscountRuleGetPayload<{ select: typeof DISCOUNT_SELECT }>;
type TaxRateRow = Prisma.TaxRateGetPayload<{ select: typeof TAX_RATE_SELECT }>;

function toTaxRateSummary(row: TaxRateRow) {
  return {
    id: row.id,
    hsnSacCode: row.hsnSacCode,
    gstRate: row.gstRate.toFixed(2),
    cessRate: row.cessRate.toFixed(2),
    description: row.description,
    effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString().slice(0, 10) : null,
    createdAt: row.createdAt,
  };
}
