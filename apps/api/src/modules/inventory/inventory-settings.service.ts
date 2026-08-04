import { Injectable } from '@nestjs/common';
import type { UpsertInventorySettingDto } from '@hixaa/contracts';
import { PinoLogger } from 'nestjs-pino';
import { NotFoundError } from '../../common/errors/domain.error';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/**
 * Per-warehouse reorder policy.
 *
 * Deliberately per (product, warehouse) rather than per product: a reorder
 * level is a function of that location's lead time and consumption, and one
 * global number would be wrong at every site that is not the average.
 */
@Injectable()
export class InventorySettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InventorySettingsService.name);
  }

  async upsert(dto: UpsertInventorySettingDto, actorId: string) {
    const [product, warehouse] = await Promise.all([
      this.prisma.db.product.findFirst({ where: { id: dto.productId }, select: { id: true, sku: true } }),
      // Through the scoped client: a caller cannot set a reorder policy in a
      // warehouse they cannot see.
      this.prisma.db.warehouse.findFirst({
        where: { id: dto.warehouseId },
        select: { id: true, code: true },
      }),
    ]);
    if (!product) throw new NotFoundError('Product', dto.productId);
    if (!warehouse) throw new NotFoundError('Warehouse', dto.warehouseId);

    return this.prisma.transaction(async (tx) => {
      const setting = await tx.inventorySetting.upsert({
        where: {
          productId_warehouseId: { productId: dto.productId, warehouseId: dto.warehouseId },
        },
        create: {
          productId: dto.productId,
          warehouseId: dto.warehouseId,
          reorderLevel: dto.reorderLevel,
          reorderQuantity: dto.reorderQuantity,
          maxLevel: dto.maxLevel ?? null,
          alertEnabled: dto.alertEnabled,
        },
        update: {
          reorderLevel: dto.reorderLevel,
          reorderQuantity: dto.reorderQuantity,
          maxLevel: dto.maxLevel ?? null,
          alertEnabled: dto.alertEnabled,
        },
        select: {
          id: true,
          productId: true,
          warehouseId: true,
          reorderLevel: true,
          reorderQuantity: true,
          maxLevel: true,
          alertEnabled: true,
        },
      });

      await this.audit.record(tx, {
        action: 'inventory.reorder_policy_set',
        entityType: 'Product',
        entityId: dto.productId,
        after: {
          warehouse: warehouse.code,
          reorderLevel: dto.reorderLevel,
          reorderQuantity: dto.reorderQuantity,
        },
        metadata: { actorId },
      });

      return {
        ...setting,
        reorderLevel: setting.reorderLevel.toFixed(4),
        reorderQuantity: setting.reorderQuantity.toFixed(4),
        maxLevel: setting.maxLevel ? setting.maxLevel.toFixed(4) : null,
        sku: product.sku,
        warehouseCode: warehouse.code,
      };
    });
  }
}
