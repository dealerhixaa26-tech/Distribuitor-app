import { Injectable } from '@nestjs/common';
import {
  SETTING_SCHEMAS,
  isWritableSetting,
  settingKey,
  type SettingEntry,
} from '@hixaa/contracts';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain.error';
import { zodToFieldErrors } from '../../common/filters/all-exceptions.filter';
import { AppConfigService } from '../../config/app-config.service';
import { CacheKeys, RedisService } from '../../infrastructure/cache/redis.service';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/**
 * Typed access to `system_setting`.
 *
 * Two consumers with different needs:
 *   • The Admin Panel reads and writes whole categories.
 *   • Services read one value on a hot path (every invoice needs the company
 *     GSTIN), so reads are cached in Redis and invalidated on write.
 *
 * Secrets are redacted on read. A settings screen is exactly where a
 * credential would leak by accident.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SettingsService.name);
  }

  /**
   * Reads one setting, cached.
   *
   * Returns the raw value including secrets — this is the internal accessor
   * services use. The controller uses `listCategory`, which redacts.
   */
  async get<T = unknown>(category: string, key: string): Promise<T | null> {
    const cacheKey = CacheKeys.systemSettings(settingKey(category, key));

    const cached = await this.redis.get<{ value: T }>(cacheKey);
    if (cached) return cached.value;

    const row = await this.prisma.db.systemSetting.findUnique({
      where: { category_key: { category, key } },
      select: { value: true },
    });
    if (!row) return null;

    await this.redis.set(cacheKey, { value: row.value }, this.config.cache.referenceTtl);
    return row.value as T;
  }

  /** Reads one setting or throws — for values the system cannot run without. */
  async require<T = unknown>(category: string, key: string): Promise<T> {
    const value = await this.get<T>(category, key);
    if (value === null) throw new NotFoundError('Setting', settingKey(category, key));
    return value;
  }

  /** Every setting in a category, redacted and marked writable. */
  async listCategory(category: string): Promise<SettingEntry[]> {
    const rows = await this.prisma.db.systemSetting.findMany({
      where: { category },
      orderBy: { key: 'asc' },
      select: {
        category: true,
        key: true,
        value: true,
        description: true,
        isSecret: true,
        updatedAt: true,
      },
    });

    if (rows.length === 0) throw new NotFoundError('Setting category', category);

    return rows.map((row) => ({
      category: row.category,
      key: row.key,
      // Never send a secret to a browser, even to an administrator — the value
      // is only ever needed server-side.
      value: row.isSecret ? '••••••••' : row.value,
      description: row.description,
      isSecret: row.isSecret,
      writable: isWritableSetting(row.category, row.key),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /** The distinct categories, for building the settings navigation. */
  async listCategories(): Promise<Array<{ category: string; count: number }>> {
    const rows = await this.prisma.db.systemSetting.groupBy({
      by: ['category'],
      _count: { key: true },
      orderBy: { category: 'asc' },
    });
    return rows.map((row) => ({ category: row.category, count: row._count.key }));
  }

  /**
   * Updates one setting after validating it against its registered schema.
   *
   * A key with no schema is rejected rather than stored: settings are a
   * structured configuration surface, and an unvalidated blob here becomes
   * something every downstream consumer has to defensively parse.
   */
  async update(
    category: string,
    key: string,
    rawValue: unknown,
    actorId: string,
  ): Promise<SettingEntry> {
    const fullKey = settingKey(category, key);
    const schema = SETTING_SCHEMAS[fullKey];

    if (!schema) {
      throw new ConflictError(
        `"${fullKey}" is not an editable setting. Seeded reference content such as the ` +
          'portfolio catalogue is managed in code and reconciled on deploy.',
      );
    }

    let value: unknown;
    try {
      value = schema.parse(rawValue);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(`Invalid value for ${fullKey}`, zodToFieldErrors(error));
      }
      throw error;
    }

    const existing = await this.prisma.db.systemSetting.findUnique({
      where: { category_key: { category, key } },
      select: { id: true, value: true, isSecret: true, description: true },
    });
    if (!existing) throw new NotFoundError('Setting', fullKey);

    const updated = await this.prisma.transaction(async (tx) => {
      const row = await tx.systemSetting.update({
        where: { category_key: { category, key } },
        data: { value: value as Prisma.InputJsonValue, updatedById: actorId },
        select: {
          category: true,
          key: true,
          value: true,
          description: true,
          isSecret: true,
          updatedAt: true,
        },
      });

      await this.audit.record(tx, {
        // Settings drive tax calculation, approval ceilings, and identity on
        // legal documents. Every change is a security event, not a data edit.
        category: 'SECURITY',
        action: 'setting.updated',
        entityType: 'SystemSetting',
        entityId: existing.id,
        before: existing.isSecret ? { redacted: true } : { value: existing.value },
        after: existing.isSecret ? { redacted: true } : { value },
        metadata: { settingKey: fullKey },
      });

      return row;
    });

    await this.invalidate(category, key);

    this.logger.warn({ settingKey: fullKey, actorId }, 'System setting changed');

    return {
      category: updated.category,
      key: updated.key,
      value: updated.isSecret ? '••••••••' : updated.value,
      description: updated.description,
      isSecret: updated.isSecret,
      writable: true,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  private async invalidate(category: string, key: string): Promise<void> {
    await this.redis.del(CacheKeys.systemSettings(settingKey(category, key)));
  }

  // ── Convenience accessors for hot paths ───────────────────────────────────

  /**
   * The company's statutory identity, used on every invoice.
   *
   * `verified` is what the invoicing module checks before issuing: a
   * placeholder GSTIN must not be able to produce a legally defective document.
   */
  async companyStatutory(): Promise<{
    gstin: string;
    pan: string;
    stateCode: string;
    verified: boolean;
  }> {
    return this.require('company', 'statutory');
  }

  async financeDefaults(): Promise<{
    currency: string;
    financialYearStartMonth: number;
    invoicePrefix: string;
    orderPrefix: string;
    roundInvoiceToWholeRupee: boolean;
  }> {
    return this.require('finance', 'defaults');
  }
}
