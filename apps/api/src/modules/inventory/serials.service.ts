import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import { AlreadyExistsError, NotFoundError } from '../../common/errors/domain.error';
import { keysetWhere, toListResult } from '../../common/utils/pagination.util';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../infrastructure/database/prisma.service';

/**
 * Serial numbers. See ADR-0009.
 *
 * Serials are created AT DISPATCH, not at receipt. Between receipt and dispatch
 * units are fungible; the identity is established when it starts to matter,
 * which is the moment the unit leaves Hixaa and a warranty obligation attaches.
 *
 * The question this table exists to answer, given a serial found on a device in
 * a confined space eighteen months from now: which distributor received it,
 * when, and is it still in warranty?
 */
const SERIAL_SELECT = {
  id: true,
  serial: true,
  status: true,
  productId: true,
  warehouseId: true,
  currentDistributorId: true,
  currentCustomerId: true,
  warrantyStart: true,
  warrantyEnd: true,
  dispatchedAt: true,
  createdAt: true,
  product: { select: { sku: true, name: true, warrantyMonths: true } },
  currentDistributor: { select: { code: true, legalName: true } },
} satisfies Prisma.SerialNumberSelect;

type SerialRow = Prisma.SerialNumberGetPayload<{ select: typeof SERIAL_SELECT }>;

@Injectable()
export class SerialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SerialsService.name);
  }

  /**
   * Registers serials as dispatched. Called from inside the issue transaction,
   * so a duplicate serial rolls the whole issue back rather than leaving stock
   * moved and identity half-recorded.
   */
  async recordDispatched(
    tx: PrismaTransaction,
    input: {
      productId: string;
      serials: readonly string[];
      distributorId: string | null;
      batchId: string | null;
      dispatchedAt: Date;
      actorId: string;
    },
  ): Promise<number> {
    const normalised = input.serials.map((s) => s.trim().toUpperCase());

    // A duplicate WITHIN the request never reaches the database constraint,
    // because the same value inserted twice in one statement set is caught
    // there — but catching it here names the offending serial.
    const seen = new Set<string>();
    for (const serial of normalised) {
      if (seen.has(serial)) {
        throw new AlreadyExistsError('serial number', 'serial', serial);
      }
      seen.add(serial);
    }

    const clashes = await tx.serialNumber.findMany({
      where: { serial: { in: normalised } },
      select: { serial: true, status: true },
    });
    if (clashes.length > 0) {
      const first = clashes[0];
      throw new AlreadyExistsError('serial number', 'serial', first?.serial ?? '');
    }

    const product = await tx.product.findFirst({
      where: { id: input.productId },
      select: { warrantyMonths: true },
    });

    // Warranty opens at DISPATCH, so shelf time does not erode the buyer's
    // cover (ADR-0009 §3).
    const warrantyStart = input.dispatchedAt;
    const warrantyEnd = product?.warrantyMonths
      ? addMonths(warrantyStart, product.warrantyMonths)
      : null;

    await tx.serialNumber.createMany({
      data: normalised.map((serial) => ({
        productId: input.productId,
        serial,
        status: 'SOLD' as const,
        // Dispatched: no longer in a Hixaa warehouse.
        warehouseId: null,
        batchId: input.batchId,
        currentDistributorId: input.distributorId,
        warrantyStart,
        warrantyEnd,
        dispatchedAt: input.dispatchedAt,
        createdById: input.actorId,
      })),
    });

    return normalised.length;
  }

  async list(query: {
    q?: string;
    productId?: string;
    distributorId?: string;
    status?: string;
    warrantyExpiringInDays?: number;
    cursor?: string;
    limit: number;
    includeTotal: boolean;
  }) {
    const where: Prisma.SerialNumberWhereInput = {
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.distributorId ? { currentDistributorId: query.distributorId } : {}),
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.q ? { serial: { contains: query.q.trim().toUpperCase() } } : {}),
    };

    if (query.warrantyExpiringInDays !== undefined) {
      where.warrantyEnd = {
        gte: this.clock.now(),
        lte: this.clock.plusDays(query.warrantyExpiringInDays),
      };
    }

    const cursorWhere = keysetWhere(query.cursor);
    const rows = await this.prisma.db.serialNumber.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: SERIAL_SELECT,
    });

    const totalCount = query.includeTotal
      ? await this.prisma.db.serialNumber.count({ where })
      : undefined;

    const result = toListResult(rows, query.limit, totalCount);
    return { ...result, data: result.data.map((row) => this.toTrace(row)) };
  }

  /**
   * The trace lookup — the reason this table exists.
   *
   * Takes the serial itself rather than an id: the person asking is holding the
   * device and reading the label off it, not browsing a list.
   */
  async trace(serial: string) {
    const row = await this.prisma.db.serialNumber.findFirst({
      where: { serial: serial.trim().toUpperCase() },
      select: SERIAL_SELECT,
    });
    if (!row) throw new NotFoundError('Serial number', serial);
    return this.toTrace(row);
  }

  private toTrace(row: SerialRow) {
    const now = this.clock.now();
    return {
      id: row.id,
      serial: row.serial,
      status: row.status,
      productId: row.productId,
      sku: row.product.sku,
      productName: row.product.name,
      distributorId: row.currentDistributorId,
      distributorName: row.currentDistributor?.legalName ?? null,
      distributorCode: row.currentDistributor?.code ?? null,
      warehouseId: row.warehouseId,
      warrantyStart: row.warrantyStart ? toDateOnly(row.warrantyStart) : null,
      warrantyEnd: row.warrantyEnd ? toDateOnly(row.warrantyEnd) : null,
      isUnderWarranty: row.warrantyEnd !== null && row.warrantyEnd >= now,
      dispatchedAt: row.dispatchedAt,
    };
  }
}

/**
 * Adds calendar months, clamping to the end of a shorter month.
 *
 * A 12-month warranty from 31 January must end on 31 January, and from
 * 31 August must end 31 August — not silently roll into March or September,
 * which naive date arithmetic does.
 */
function addMonths(from: Date, months: number): Date {
  const result = new Date(from);
  const targetMonth = result.getUTCMonth() + months;
  const dayOfMonth = result.getUTCDate();

  result.setUTCDate(1);
  result.setUTCMonth(targetMonth);

  const lastDayOfTarget = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(dayOfMonth, lastDayOfTarget));

  return result;
}

const toDateOnly = (date: Date): string => date.toISOString().slice(0, 10);
