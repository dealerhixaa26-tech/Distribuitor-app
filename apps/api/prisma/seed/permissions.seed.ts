import { ALL_PERMISSIONS, PERMISSIONS, ROLE_KEYS, parsePermission } from '@hixaa/contracts';
import type { PrismaClient, ScopeType } from '@prisma/client';

/**
 * Seeds the permission catalogue and the system roles.
 *
 * Idempotent by natural key, so it runs safely on every deploy: new permissions
 * appear, and a role's grant set is reconciled to match this file. That makes
 * this the authoritative definition — an operator cannot quietly grant a system
 * role an extra permission through the UI and have it survive a deploy.
 */

const P = PERMISSIONS;

interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  scopeType: ScopeType;
  level: number;
  maxDiscountPercent?: number;
  maxOrderValue?: number;
  permissions: readonly string[] | 'ALL';
}

/** Every read permission — the Auditor's grant. */
const ALL_READS = ALL_PERMISSIONS.filter((p) => parsePermission(p).action === 'read');

export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    key: ROLE_KEYS.SUPER_ADMIN,
    name: 'Super Administrator',
    description: 'Full control, including settings, restores, and role management.',
    scopeType: 'GLOBAL',
    level: 100,
    permissions: 'ALL',
  },
  {
    key: ROLE_KEYS.ADMIN,
    name: 'Administrator',
    description: 'Day-to-day administration. Cannot restore backups or impersonate users.',
    scopeType: 'GLOBAL',
    level: 90,
    permissions: ALL_PERMISSIONS.filter(
      (p) =>
        p !== P.BACKUP_RESTORE &&
        p !== P.USER_IMPERSONATE &&
        p !== P.ROLE_CREATE &&
        p !== P.ROLE_UPDATE &&
        p !== P.ROLE_DELETE,
    ),
  },
  {
    key: ROLE_KEYS.SALES_MANAGER,
    name: 'Sales Manager',
    description: 'Owns a territory. Approves orders and discounts within ceiling.',
    scopeType: 'TERRITORY',
    level: 60,
    maxDiscountPercent: 10,
    maxOrderValue: 2_500_000,
    permissions: [
      P.DISTRIBUTOR_READ, P.DISTRIBUTOR_CREATE, P.DISTRIBUTOR_UPDATE, P.DISTRIBUTOR_APPROVE,
      P.DISTRIBUTOR_DOCUMENT_MANAGE, P.DISTRIBUTOR_EXPORT,
      P.CUSTOMER_READ, P.CUSTOMER_CREATE, P.CUSTOMER_UPDATE,
      P.TERRITORY_READ,
      P.PRODUCT_READ, P.CATEGORY_READ, P.PRICELIST_READ,
      P.DISCOUNT_READ, P.DISCOUNT_APPROVE,
      P.QUOTATION_READ, P.QUOTATION_CREATE, P.QUOTATION_UPDATE, P.QUOTATION_SEND, P.QUOTATION_CONVERT,
      // Note: no ORDER_CREATE. A manager who could both raise and approve an
      // order would defeat the separation below.
      P.ORDER_READ, P.ORDER_APPROVE, P.ORDER_REJECT, P.ORDER_CANCEL,
      P.INVOICE_READ, P.PAYMENT_READ,
      P.INVENTORY_READ, P.WAREHOUSE_READ,
      P.ANALYTICS_READ, P.REPORT_READ, P.REPORT_RUN, P.REPORT_EXPORT,
      P.DOCUMENT_READ, P.DOCUMENT_UPLOAD, P.NOTIFICATION_READ,
    ],
  },
  {
    key: ROLE_KEYS.SALES_EXECUTIVE,
    name: 'Sales Executive',
    description: 'Creates quotations and orders for assigned distributors. Cannot approve.',
    scopeType: 'TERRITORY',
    level: 40,
    maxDiscountPercent: 0,
    permissions: [
      P.DISTRIBUTOR_READ, P.DISTRIBUTOR_CREATE, P.DISTRIBUTOR_UPDATE,
      P.CUSTOMER_READ, P.CUSTOMER_CREATE, P.CUSTOMER_UPDATE,
      P.TERRITORY_READ,
      P.PRODUCT_READ, P.CATEGORY_READ, P.PRICELIST_READ,
      P.QUOTATION_READ, P.QUOTATION_CREATE, P.QUOTATION_UPDATE, P.QUOTATION_SEND,
      P.ORDER_READ, P.ORDER_CREATE, P.ORDER_UPDATE, P.ORDER_SUBMIT,
      P.INVOICE_READ, P.PAYMENT_READ,
      P.INVENTORY_READ,
      P.ANALYTICS_READ, P.REPORT_READ, P.REPORT_RUN,
      P.DOCUMENT_READ, P.DOCUMENT_UPLOAD, P.NOTIFICATION_READ,
    ],
  },
  {
    key: ROLE_KEYS.INVENTORY_MANAGER,
    name: 'Inventory Manager',
    description: 'Warehouses, stock movements, transfers, and dispatch.',
    scopeType: 'GLOBAL',
    level: 50,
    permissions: [
      P.INVENTORY_READ, P.INVENTORY_RECEIVE, P.INVENTORY_ISSUE, P.INVENTORY_ADJUST,
      P.INVENTORY_TRANSFER, P.INVENTORY_COUNT,
      P.WAREHOUSE_READ, P.WAREHOUSE_CREATE, P.WAREHOUSE_UPDATE, P.WAREHOUSE_DELETE,
      P.PRODUCT_READ, P.PRODUCT_UPDATE, P.CATEGORY_READ,
      P.ORDER_READ, P.ORDER_DISPATCH,
      P.DISTRIBUTOR_READ,
      P.ANALYTICS_READ, P.REPORT_READ, P.REPORT_RUN,
      P.DOCUMENT_READ, P.DOCUMENT_UPLOAD, P.NOTIFICATION_READ,
    ],
  },
  {
    key: ROLE_KEYS.FINANCE_MANAGER,
    name: 'Finance Manager',
    description: 'Invoices, payments, credit limits, credit notes, and GST returns.',
    scopeType: 'GLOBAL',
    level: 70,
    maxDiscountPercent: 20,
    permissions: [
      P.INVOICE_READ, P.INVOICE_ISSUE, P.INVOICE_CANCEL, P.INVOICE_CREDIT_NOTE,
      P.INVOICE_SEND, P.INVOICE_EXPORT,
      // Note: no INVOICE_CREATE — drafting and issuing stay separate.
      P.PAYMENT_READ, P.PAYMENT_VERIFY, P.PAYMENT_ALLOCATE, P.PAYMENT_UPDATE,
      // PAYMENT_DELETE gates ledger write-offs and adjustments. It was held by
      // no business role until Phase 9 — only SUPER_ADMIN — which made writing
      // off bad debt a system-administration task and, with a single admin
      // account, impossible above the approval threshold. Deciding what the
      // company will not collect is a Finance Manager's job; found by trying to
      // exercise the approval chain (docs/26 §4).
      P.PAYMENT_DELETE,
      P.DISTRIBUTOR_READ, P.DISTRIBUTOR_CREDIT_UPDATE,
      P.CUSTOMER_READ, P.ORDER_READ, P.PRODUCT_READ, P.PRICELIST_READ,
      // ORDER_APPROVE is required for the credit-limit override, not for
      // routine approval: docs/00 §4.2 invariant 1 says a breach may only be
      // forgiven by a Finance Manager, and that override is exercised THROUGH
      // `POST /orders/:id/approve`. Without this the invariant is
      // unimplementable — found in Phase 7 by attempting it. The 20% discount
      // ceiling still bounds what they may approve, and self-approval is
      // refused regardless of role.
      P.ORDER_APPROVE,
      P.DISCOUNT_READ, P.DISCOUNT_APPROVE,
      P.ANALYTICS_READ, P.ANALYTICS_READ_FINANCIAL,
      P.REPORT_READ, P.REPORT_CREATE, P.REPORT_RUN, P.REPORT_SCHEDULE, P.REPORT_EXPORT,
      P.DOCUMENT_READ, P.DOCUMENT_UPLOAD, P.NOTIFICATION_READ,
    ],
  },
  {
    key: ROLE_KEYS.ACCOUNTS_EXECUTIVE,
    name: 'Accounts Executive',
    description: 'Records payments and drafts invoices. Cannot verify or issue.',
    scopeType: 'GLOBAL',
    level: 30,
    permissions: [
      P.PAYMENT_READ, P.PAYMENT_CREATE, P.PAYMENT_ALLOCATE,
      // Deliberately absent: PAYMENT_VERIFY and INVOICE_ISSUE.
      P.INVOICE_READ, P.INVOICE_CREATE,
      P.DISTRIBUTOR_READ, P.CUSTOMER_READ, P.ORDER_READ,
      P.REPORT_READ, P.REPORT_RUN,
      P.DOCUMENT_READ, P.DOCUMENT_UPLOAD, P.NOTIFICATION_READ,
    ],
  },
  {
    key: ROLE_KEYS.SUPPORT_AGENT,
    name: 'Support Agent',
    description: 'Read access for query resolution.',
    scopeType: 'GLOBAL',
    level: 20,
    permissions: [
      P.DISTRIBUTOR_READ, P.CUSTOMER_READ, P.ORDER_READ, P.INVOICE_READ,
      P.PAYMENT_READ, P.PRODUCT_READ, P.CATEGORY_READ, P.INVENTORY_READ,
      P.QUOTATION_READ, P.DOCUMENT_READ,
      P.NOTIFICATION_READ, P.NOTIFICATION_SEND,
    ],
  },
  {
    key: ROLE_KEYS.AUDITOR,
    name: 'Auditor',
    description: 'Strictly read-only across the system, including the audit log.',
    scopeType: 'GLOBAL',
    level: 10,
    permissions: [...ALL_READS, P.AUDITLOG_READ, P.AUDITLOG_EXPORT, P.ANALYTICS_READ_FINANCIAL],
  },

  // ── v2 Distributor Portal. Seeded now so the scope machinery is exercised
  //    and tested long before the portal UI exists. See ADR-0003.
  {
    key: ROLE_KEYS.DISTRIBUTOR_OWNER,
    name: 'Distributor Owner',
    description: 'Portal role — full access to their own distributor’s data only.',
    scopeType: 'DISTRIBUTOR',
    level: 15,
    permissions: [
      P.ORDER_READ, P.ORDER_CREATE, P.ORDER_SUBMIT,
      P.QUOTATION_READ,
      P.INVOICE_READ, P.PAYMENT_READ,
      P.PRODUCT_READ, P.CATEGORY_READ, P.PRICELIST_READ,
      P.INVENTORY_READ,
      P.CUSTOMER_READ, P.CUSTOMER_CREATE, P.CUSTOMER_UPDATE,
      P.DOCUMENT_READ, P.DOCUMENT_UPLOAD, P.NOTIFICATION_READ,
    ],
  },
  {
    key: ROLE_KEYS.DISTRIBUTOR_STAFF,
    name: 'Distributor Staff',
    description: 'Portal role — restricted subset of the owner’s access.',
    scopeType: 'DISTRIBUTOR',
    level: 5,
    permissions: [
      P.ORDER_READ, P.ORDER_CREATE,
      P.PRODUCT_READ, P.CATEGORY_READ,
      P.INVOICE_READ, P.NOTIFICATION_READ,
    ],
  },
];

export async function seedPermissions(prisma: PrismaClient): Promise<void> {
  for (const key of ALL_PERMISSIONS) {
    const { resource, action } = parsePermission(key);
    await prisma.permission.upsert({
      where: { key },
      create: { key, resource, action, description: describe(resource, action) },
      update: { resource, action },
    });
  }
  console.log(`  ✓ ${ALL_PERMISSIONS.length} permissions`);
}

export async function seedRoles(prisma: PrismaClient): Promise<void> {
  const permissionIds = new Map(
    (await prisma.permission.findMany({ select: { id: true, key: true } })).map((p) => [
      p.key,
      p.id,
    ]),
  );

  for (const definition of ROLE_DEFINITIONS) {
    const role = await prisma.role.upsert({
      where: { key: definition.key },
      create: {
        key: definition.key,
        name: definition.name,
        description: definition.description,
        scopeType: definition.scopeType,
        level: definition.level,
        isSystem: true,
        maxDiscountPercent: definition.maxDiscountPercent ?? null,
        maxOrderValue: definition.maxOrderValue ?? null,
      },
      update: {
        name: definition.name,
        description: definition.description,
        scopeType: definition.scopeType,
        level: definition.level,
        maxDiscountPercent: definition.maxDiscountPercent ?? null,
        maxOrderValue: definition.maxOrderValue ?? null,
      },
      select: { id: true },
    });

    const granted =
      definition.permissions === 'ALL' ? ALL_PERMISSIONS : [...definition.permissions];

    // Reconcile rather than append, so revoking a permission here actually
    // revokes it on the next deploy.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: granted
        .map((key) => permissionIds.get(key))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });

    console.log(`  ✓ ${definition.key.padEnd(20)} ${granted.length} permissions`);
  }
}

function describe(resource: string, action: string): string {
  const verb =
    { read: 'View', create: 'Create', update: 'Edit', delete: 'Remove' }[action] ??
    action.charAt(0).toUpperCase() + action.slice(1);
  return `${verb} ${resource}`;
}
