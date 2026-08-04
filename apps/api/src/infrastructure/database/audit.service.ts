import { Injectable } from '@nestjs/common';
import type { ActorType, AuditCategory, Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { RequestContextStore } from '../../common/context/request-context';
import { PrismaService, type PrismaTransaction } from './prisma.service';

/**
 * Audit recording.
 *
 * ── Deviation from docs/01-architecture.md §4, deliberately made ────────────
 * The design sketched audit as a Prisma client extension, alongside soft-delete
 * and scope. Implementing it revealed a correctness problem: an extension
 * cannot reliably join the caller's ambient transaction, so an audit row would
 * be written for a business write that later rolled back. An audit log that
 * records events which did not happen is worse than one with gaps, because it
 * is no longer evidence.
 *
 * So audit is explicit: services call `record(tx, …)` inside their transaction,
 * and the audit row commits or rolls back with the change it describes.
 *
 * Soft-delete and scope remain extensions because they only *shape queries* —
 * there is no atomicity requirement, and forgetting them is a security problem
 * rather than a correctness one. The trade is intentional in both directions.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Field names never written to the audit log in cleartext. */
const REDACTED_FIELDS = new Set([
  'password',
  'passwordHash',
  'refreshTokenHash',
  'tokenHash',
  'keyHash',
  'secretEncrypted',
  'backupCodes',
  'bankAccountNumber',
  'otp',
  'mfaSecret',
]);

/**
 * Changing any of these raises a security event to the ops channel in addition
 * to the audit row. See docs/06-security.md §8.
 */
const SENSITIVE_FIELDS = new Set([
  'creditLimit',
  'gstin',
  'pan',
  'bankAccountNumber',
  'bankIfsc',
  'status',
  'roleId',
  'permissions',
  'maxDiscountPercent',
  'maxOrderValue',
]);

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  category?: AuditCategory;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuditService.name);
  }

  /**
   * Records an entry inside the caller's transaction.
   *
   * Always pass `tx`. Passing the non-transactional client means the audit row
   * can survive a rolled-back business write, which is the exact failure this
   * design exists to avoid.
   */
  async record(tx: PrismaTransaction, entry: AuditEntry): Promise<void> {
    const context = RequestContextStore.get();

    await tx.auditLog.create({
      data: {
        actorUserId: context?.userId ?? null,
        actorType: (context?.actorType ?? 'SYSTEM') as ActorType,
        actorLabel: context?.actorLabel ?? null,
        category: entry.category ?? 'DATA',
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        before: redact(entry.before) as Prisma.InputJsonValue,
        after: redact(entry.after) as Prisma.InputJsonValue,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
        requestId: context?.requestId ?? null,
        metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Records an entry outside any transaction.
   *
   * Only for events with no accompanying database write — a failed login, a
   * permission denial, a read of a restricted export. There is nothing to be
   * atomic with, so a standalone insert is correct here.
   */
  async recordStandalone(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.transaction((tx) => this.record(tx, entry));
    } catch (error) {
      // Never let audit failure break the request it is describing. It is
      // logged loudly instead so the gap is visible.
      this.logger.error({ err: error, action: entry.action }, 'Failed to write audit entry');
    }
  }

  /**
   * Returns the changed fields between two states, so the audit log stores a
   * diff rather than two full row images. Cheaper to store and far easier to
   * read six months later.
   */
  static diff(
    before: Record<string, unknown> | null | undefined,
    after: Record<string, unknown> | null | undefined,
  ): { before: Record<string, unknown>; after: Record<string, unknown>; changed: string[] } {
    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};
    const changed: string[] = [];

    const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);

    for (const key of keys) {
      const previous = before?.[key];
      const next = after?.[key];
      if (JSON.stringify(previous) === JSON.stringify(next)) continue;

      changed.push(key);
      changedBefore[key] = previous;
      changedAfter[key] = next;
    }

    return { before: changedBefore, after: changedAfter, changed };
  }

  /** True when a change touches a field that warrants a security alert. */
  static touchesSensitiveField(changedFields: readonly string[]): boolean {
    return changedFields.some((field) => SENSITIVE_FIELDS.has(field));
  }
}

/** Recursively replaces secret-bearing fields with a marker. */
function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = REDACTED_FIELDS.has(key) ? '[REDACTED]' : redact(item);
  }
  return output;
}
