import { Injectable } from '@nestjs/common';
import {
  Money,
  OUTSTANDING_INVOICE_STATUSES,
  type CreditCheckResult,
} from '@hixaa/contracts';
import { PinoLogger } from 'nestjs-pino';
import {
  CreditLimitExceededError,
  PermissionDeniedError,
  SelfApprovalError,
} from '../../common/errors/domain.error';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/**
 * Credit checking and approval ceilings — the two gates on `APPROVED`.
 *
 * Split out of `OrdersService` because these are the phase's controls, and a
 * control buried in a 600-line workflow service is a control nobody reviews.
 * Everything here is a question with a yes/no answer and a reason.
 *
 * Both gates implement invariants from `docs/00-domain-and-scope.md` §4.2:
 * a distributor cannot exceed its credit limit without an audited override, and
 * a concession must be granted by someone whose authority covers it.
 */
@Injectable()
export class OrderApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OrderApprovalService.name);
  }

  // ── Credit ────────────────────────────────────────────────────────────────

  /**
   * Computes exposure and decides whether this order would breach the limit.
   *
   * Exposure is **approved-but-undispatched order value + outstanding
   * invoices**. Phase 8 owns invoices, so that second term is zero today — the
   * shape is written to accept it arriving without changing, which is why it is
   * a named variable rather than absent.
   *
   * Returns the figures whether or not it passes, so a refusal and an override
   * both show the same numbers rather than the reason appearing only in an
   * error string.
   */
  async checkCredit(input: {
    distributorId: string;
    orderValue: string;
    /** Excluded from exposure when re-checking an order already counted. */
    excludeOrderId?: string;
  }): Promise<CreditCheckResult> {
    const distributor = await this.prisma.db.distributor.findFirst({
      where: { id: input.distributorId },
      select: { id: true, code: true, creditLimit: true },
    });
    if (!distributor) {
      // Reached only if the order references a distributor the caller cannot
      // see; the order load would already have 404'd.
      throw new CreditLimitExceededError(input.distributorId, '0', '0');
    }

    const openOrders = await this.prisma.db.order.aggregate({
      where: {
        distributorId: input.distributorId,
        type: 'PRIMARY',
        status: { in: ['APPROVED', 'PROCESSING', 'PARTIALLY_DISPATCHED', 'DISPATCHED'] },
        ...(input.excludeOrderId ? { id: { not: input.excludeOrderId } } : {}),
      },
      _sum: { grandTotal: true },
    });

    const committedOrders = Money.of(openOrders._sum.grandTotal?.toFixed(4) ?? '0');

    /*
     * Phase 8, as predicted: one line, because the shape was right.
     *
     * `amountOutstanding` is trigger-maintained from
     * `grandTotal − amountPaid − amountCredited`, so it cannot drift from the
     * document it describes. `OUTSTANDING_INVOICE_STATUSES` is shared with
     * `OutstandingService` so the aging report and the credit check cannot
     * disagree about what "outstanding" means.
     *
     * ⚠️ Consequence worth stating plainly: every distributor's available
     * credit DROPS the moment this ships, because exposure now includes money
     * genuinely owed that the system previously ignored. That is a correction,
     * not a regression — orders that newly require a credit override are orders
     * that always should have.
     */
    const invoiceBalance = await this.prisma.db.invoice.aggregate({
      where: {
        distributorId: input.distributorId,
        status: { in: [...OUTSTANDING_INVOICE_STATUSES] },
      },
      _sum: { amountOutstanding: true },
    });
    const outstandingInvoices = Money.of(
      invoiceBalance._sum.amountOutstanding?.toFixed(4) ?? '0',
    );

    const currentExposure = committedOrders.add(outstandingInvoices);
    const creditLimit = Money.of(distributor.creditLimit.toFixed(4));
    const orderValue = Money.of(input.orderValue);
    const headroom = creditLimit.subtract(currentExposure).subtract(orderValue);

    return {
      distributorCode: distributor.code,
      creditLimit: creditLimit.toString(),
      currentExposure: currentExposure.toString(),
      orderValue: orderValue.toString(),
      headroom: headroom.toString(),
      wouldExceed: headroom.isNegative(),
    };
  }

  /**
   * Enforces the credit gate.
   *
   * A breach is refused unless the caller may override AND has said why. A
   * `creditLimit` of zero means no credit at all — every order needs an
   * override — which is the correct reading of zero and the state a newly
   * activated distributor starts in.
   */
  async assertCreditOrOverride(input: {
    check: CreditCheckResult;
    overrideReason?: string;
    approverId: string;
  }): Promise<{ overridden: boolean }> {
    if (!input.check.wouldExceed) return { overridden: false };

    if (!input.overrideReason) {
      throw new CreditLimitExceededError(
        input.check.distributorCode,
        input.check.creditLimit,
        input.check.currentExposure,
      );
    }

    // Only Finance and above may forgive a credit breach. Checked here rather
    // than by a route guard because the permission is conditional — the same
    // endpoint is legitimate without an override.
    const mayOverride = await this.holdsCreditAuthority(input.approverId);
    if (!mayOverride) {
      throw new PermissionDeniedError('distributor:credit:update');
    }

    this.logger.warn(
      {
        distributor: input.check.distributorCode,
        limit: input.check.creditLimit,
        exposure: input.check.currentExposure,
        orderValue: input.check.orderValue,
        approverId: input.approverId,
      },
      'CREDIT LIMIT OVERRIDDEN',
    );

    return { overridden: true };
  }

  // ── Ceilings ──────────────────────────────────────────────────────────────

  /**
   * The caller's authority: the most permissive of their roles.
   *
   * `null` means unlimited, and a single unlimited role short-circuits — holding
   * one unrestricted role must not be capped by also holding a restricted one.
   * Same reasoning as `PricingService.callerDiscountCeiling`.
   */
  async ceilingsFor(userId: string): Promise<{
    maxDiscountPercent: string | null;
    maxOrderValue: string | null;
    level: number;
  }> {
    const assignments = await this.prisma.db.userRole.findMany({
      where: { userId },
      select: {
        role: { select: { maxDiscountPercent: true, maxOrderValue: true, level: true } },
      },
    });

    let maxDiscount: Money | null = null;
    let maxOrder: Money | null = null;
    let level = 0;
    let discountUnlimited = false;
    let orderUnlimited = false;

    for (const assignment of assignments) {
      const role = assignment.role;
      level = Math.max(level, role.level);

      if (role.maxDiscountPercent === null) discountUnlimited = true;
      else {
        const value = Money.of(role.maxDiscountPercent.toFixed(4));
        maxDiscount = maxDiscount === null ? value : Money.max(maxDiscount, value);
      }

      if (role.maxOrderValue === null) orderUnlimited = true;
      else {
        const value = Money.of(role.maxOrderValue.toFixed(4));
        maxOrder = maxOrder === null ? value : Money.max(maxOrder, value);
      }
    }

    return {
      maxDiscountPercent: discountUnlimited ? null : (maxDiscount?.toString() ?? '0'),
      maxOrderValue: orderUnlimited ? null : (maxOrder?.toString() ?? '0'),
      level,
    };
  }

  /**
   * Enforces the approval gate.
   *
   * Two refusals are absolute:
   *
   *   • **Self-approval.** The order's creator may never approve it, whatever
   *     ceiling they hold. Whoever asks for a concession must not be the person
   *     who grants it — the same separation as KYC verification in Phase 5 and
   *     payment recording versus verification in the segregation rules.
   *   • **Insufficient ceiling.** The message names the ceiling and the figure,
   *     so the approver knows to escalate rather than guessing why.
   */
  async assertMayApprove(input: {
    approverId: string;
    createdById: string | null;
    maxLineDiscountPercent: string;
    orderValue: string;
  }): Promise<ApprovalDecision> {
    if (input.createdById && input.createdById === input.approverId) {
      throw new SelfApprovalError('order');
    }

    const ceilings = await this.ceilingsFor(input.approverId);
    const reasons: string[] = [];

    const discount = Money.of(input.maxLineDiscountPercent);
    if (ceilings.maxDiscountPercent !== null && discount.gt(ceilings.maxDiscountPercent)) {
      reasons.push(
        `a ${discount.round(2).toDisplayString()}% discount exceeds your ceiling of ` +
          `${Money.of(ceilings.maxDiscountPercent).toDisplayString()}%`,
      );
    }

    const value = Money.of(input.orderValue);
    if (ceilings.maxOrderValue !== null && value.gt(ceilings.maxOrderValue)) {
      reasons.push(
        `an order of ${value.format()} exceeds your ceiling of ` +
          `${Money.of(ceilings.maxOrderValue).format()}`,
      );
    }

    if (reasons.length > 0) {
      throw new ApprovalCeilingError(reasons);
    }

    return {
      approverCeilingDiscount: ceilings.maxDiscountPercent,
      approverCeilingValue: ceilings.maxOrderValue,
      // Recorded so the approval row says what authority was exercised, not
      // merely who clicked.
      exercisedDiscount: discount.toString(),
      exercisedValue: value.toString(),
    };
  }

  /** FINANCE_MANAGER level (70) or above may forgive a credit breach. */
  private async holdsCreditAuthority(userId: string): Promise<boolean> {
    const assignments = await this.prisma.db.userRole.findMany({
      where: { userId },
      select: { role: { select: { level: true, key: true } } },
    });
    return assignments.some(
      (assignment) =>
        assignment.role.level >= 70 ||
        assignment.role.key === 'FINANCE_MANAGER' ||
        assignment.role.key === 'ADMIN' ||
        assignment.role.key === 'SUPER_ADMIN',
    );
  }
}

export interface ApprovalDecision {
  approverCeilingDiscount: string | null;
  approverCeilingValue: string | null;
  exercisedDiscount: string;
  exercisedValue: string;
}

/**
 * A ceiling refusal, distinct from a plain permission denial: the caller HAS
 * the permission to approve, just not to this magnitude. Conflating the two
 * would tell a Sales Manager they cannot approve orders, when what they cannot
 * do is approve THIS one.
 */
export class ApprovalCeilingError extends PermissionDeniedError {
  constructor(readonly reasons: readonly string[]) {
    super('order:approve');
    Object.defineProperty(this, 'message', {
      value: `Cannot approve: ${reasons.join('; ')}. Escalate to someone with a higher ceiling.`,
      enumerable: true,
    });
  }
}
