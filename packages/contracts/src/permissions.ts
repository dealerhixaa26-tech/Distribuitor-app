/**
 * Permission catalogue — the authoritative list. See docs/04-rbac-and-permissions.md.
 *
 * These keys are seeded into the `permission` table on boot and referenced by
 * `@RequirePermission()` on the API and `usePermission()` on the web. Because
 * both sides import the same constants, a typo is a compile error rather than a
 * silently unenforced route.
 */

export const PERMISSIONS = {
  // ── Identity & access ─────────────────────────────────────────────────────
  USER_READ: 'user:read',
  USER_CREATE: 'user:create',
  USER_UPDATE: 'user:update',
  USER_DELETE: 'user:delete',
  USER_SUSPEND: 'user:suspend',
  USER_IMPERSONATE: 'user:impersonate',

  ROLE_READ: 'role:read',
  ROLE_CREATE: 'role:create',
  ROLE_UPDATE: 'role:update',
  ROLE_DELETE: 'role:delete',
  ROLE_ASSIGN: 'role:assign',

  TEAM_READ: 'team:read',
  TEAM_CREATE: 'team:create',
  TEAM_UPDATE: 'team:update',
  TEAM_DELETE: 'team:delete',

  // ── Channel ───────────────────────────────────────────────────────────────
  DISTRIBUTOR_READ: 'distributor:read',
  DISTRIBUTOR_CREATE: 'distributor:create',
  DISTRIBUTOR_UPDATE: 'distributor:update',
  DISTRIBUTOR_DELETE: 'distributor:delete',
  DISTRIBUTOR_APPROVE: 'distributor:approve',
  DISTRIBUTOR_IMPORT: 'distributor:import',
  DISTRIBUTOR_EXPORT: 'distributor:export',
  DISTRIBUTOR_DOCUMENT_MANAGE: 'distributor:document:manage',
  DISTRIBUTOR_CREDIT_UPDATE: 'distributor:credit:update',

  TERRITORY_READ: 'territory:read',
  TERRITORY_CREATE: 'territory:create',
  TERRITORY_UPDATE: 'territory:update',
  TERRITORY_DELETE: 'territory:delete',

  CUSTOMER_READ: 'customer:read',
  CUSTOMER_CREATE: 'customer:create',
  CUSTOMER_UPDATE: 'customer:update',
  CUSTOMER_DELETE: 'customer:delete',

  // ── Catalog & pricing ─────────────────────────────────────────────────────
  PRODUCT_READ: 'product:read',
  PRODUCT_CREATE: 'product:create',
  PRODUCT_UPDATE: 'product:update',
  PRODUCT_DELETE: 'product:delete',
  PRODUCT_IMPORT: 'product:import',
  PRODUCT_EXPORT: 'product:export',
  PRODUCT_MEDIA_MANAGE: 'product:media:manage',

  CATEGORY_READ: 'category:read',
  CATEGORY_CREATE: 'category:create',
  CATEGORY_UPDATE: 'category:update',
  CATEGORY_DELETE: 'category:delete',

  PRICELIST_READ: 'pricelist:read',
  PRICELIST_CREATE: 'pricelist:create',
  PRICELIST_UPDATE: 'pricelist:update',
  PRICELIST_DELETE: 'pricelist:delete',
  PRICELIST_PUBLISH: 'pricelist:publish',

  DISCOUNT_READ: 'discount:read',
  DISCOUNT_CREATE: 'discount:create',
  DISCOUNT_UPDATE: 'discount:update',
  DISCOUNT_DELETE: 'discount:delete',
  DISCOUNT_APPROVE: 'discount:approve',

  // ── Inventory ─────────────────────────────────────────────────────────────
  INVENTORY_READ: 'inventory:read',
  INVENTORY_RECEIVE: 'inventory:receive',
  INVENTORY_ISSUE: 'inventory:issue',
  INVENTORY_ADJUST: 'inventory:adjust',
  INVENTORY_TRANSFER: 'inventory:transfer',
  INVENTORY_COUNT: 'inventory:count',

  WAREHOUSE_READ: 'warehouse:read',
  WAREHOUSE_CREATE: 'warehouse:create',
  WAREHOUSE_UPDATE: 'warehouse:update',
  WAREHOUSE_DELETE: 'warehouse:delete',

  // ── Sales ─────────────────────────────────────────────────────────────────
  QUOTATION_READ: 'quotation:read',
  QUOTATION_CREATE: 'quotation:create',
  QUOTATION_UPDATE: 'quotation:update',
  QUOTATION_DELETE: 'quotation:delete',
  QUOTATION_SEND: 'quotation:send',
  QUOTATION_CONVERT: 'quotation:convert',

  ORDER_READ: 'order:read',
  ORDER_CREATE: 'order:create',
  ORDER_UPDATE: 'order:update',
  ORDER_DELETE: 'order:delete',
  ORDER_SUBMIT: 'order:submit',
  ORDER_APPROVE: 'order:approve',
  ORDER_REJECT: 'order:reject',
  ORDER_CANCEL: 'order:cancel',
  ORDER_DISPATCH: 'order:dispatch',

  // ── Finance ───────────────────────────────────────────────────────────────
  INVOICE_READ: 'invoice:read',
  INVOICE_CREATE: 'invoice:create',
  INVOICE_ISSUE: 'invoice:issue',
  INVOICE_CANCEL: 'invoice:cancel',
  INVOICE_CREDIT_NOTE: 'invoice:credit-note',
  INVOICE_SEND: 'invoice:send',
  INVOICE_EXPORT: 'invoice:export',

  PAYMENT_READ: 'payment:read',
  PAYMENT_CREATE: 'payment:create',
  PAYMENT_UPDATE: 'payment:update',
  PAYMENT_VERIFY: 'payment:verify',
  PAYMENT_DELETE: 'payment:delete',
  PAYMENT_ALLOCATE: 'payment:allocate',

  // ── Intelligence ──────────────────────────────────────────────────────────
  ANALYTICS_READ: 'analytics:read',
  ANALYTICS_READ_FINANCIAL: 'analytics:read:financial',

  REPORT_READ: 'report:read',
  REPORT_CREATE: 'report:create',
  REPORT_RUN: 'report:run',
  REPORT_SCHEDULE: 'report:schedule',
  REPORT_EXPORT: 'report:export',

  // ── System ────────────────────────────────────────────────────────────────
  DOCUMENT_READ: 'document:read',
  DOCUMENT_UPLOAD: 'document:upload',
  DOCUMENT_DELETE: 'document:delete',

  SETTING_READ: 'setting:read',
  SETTING_UPDATE: 'setting:update',

  AUDITLOG_READ: 'auditlog:read',
  AUDITLOG_EXPORT: 'auditlog:export',

  BACKUP_READ: 'backup:read',
  BACKUP_RUN: 'backup:run',
  BACKUP_RESTORE: 'backup:restore',

  NOTIFICATION_READ: 'notification:read',
  NOTIFICATION_SEND: 'notification:send',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];

/** Splits `distributor:document:manage` into its resource and action halves. */
export function parsePermission(permission: string): { resource: string; action: string } {
  const [resource = '', ...rest] = permission.split(':');
  return { resource, action: rest.join(':') };
}

// ── Roles ───────────────────────────────────────────────────────────────────

export const ROLE_KEYS = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  SALES_MANAGER: 'SALES_MANAGER',
  SALES_EXECUTIVE: 'SALES_EXECUTIVE',
  INVENTORY_MANAGER: 'INVENTORY_MANAGER',
  FINANCE_MANAGER: 'FINANCE_MANAGER',
  ACCOUNTS_EXECUTIVE: 'ACCOUNTS_EXECUTIVE',
  SUPPORT_AGENT: 'SUPPORT_AGENT',
  AUDITOR: 'AUDITOR',
  DISTRIBUTOR_OWNER: 'DISTRIBUTOR_OWNER',
  DISTRIBUTOR_STAFF: 'DISTRIBUTOR_STAFF',
} as const;

export type RoleKey = (typeof ROLE_KEYS)[keyof typeof ROLE_KEYS];

/**
 * Pairs that must never appear in one role. Enforced when a custom role is
 * created — financial controls that rely on people remembering them are not
 * controls. See docs/04-rbac-and-permissions.md §3.
 */
export const SEGREGATION_OF_DUTIES: ReadonlyArray<{
  a: Permission;
  b: Permission;
  reason: string;
}> = [
  {
    a: PERMISSIONS.PAYMENT_CREATE,
    b: PERMISSIONS.PAYMENT_VERIFY,
    reason: 'The person recording a receipt must not be the person who confirms it.',
  },
  {
    a: PERMISSIONS.ORDER_CREATE,
    b: PERMISSIONS.ORDER_APPROVE,
    reason: 'Order creation and approval must be separate people.',
  },
  {
    a: PERMISSIONS.INVOICE_CREATE,
    b: PERMISSIONS.INVOICE_ISSUE,
    reason: 'Only issuing consumes a statutory invoice number; drafting must not.',
  },
];

/** Returns the violated separations, or an empty array when the set is safe. */
export function findSegregationViolations(
  permissions: readonly string[],
): Array<{ a: Permission; b: Permission; reason: string }> {
  const held = new Set(permissions);
  return SEGREGATION_OF_DUTIES.filter((rule) => held.has(rule.a) && held.has(rule.b));
}

// ── Scopes ──────────────────────────────────────────────────────────────────

export const SCOPE_TYPES = {
  GLOBAL: 'GLOBAL',
  TERRITORY: 'TERRITORY',
  DISTRIBUTOR: 'DISTRIBUTOR',
} as const;

export type ScopeType = (typeof SCOPE_TYPES)[keyof typeof SCOPE_TYPES];

export interface RoleAssignment {
  roleKey: string;
  scopeType: ScopeType;
  /** Null when scopeType is GLOBAL. */
  scopeId: string | null;
}

/** The caller's effective authority, resolved once per request. */
export interface EffectiveAccess {
  userId: string;
  permissions: Permission[];
  scopeType: ScopeType;
  territoryIds: string[];
  distributorIds: string[];
}

export const hasPermission = (access: EffectiveAccess, permission: Permission): boolean =>
  access.permissions.includes(permission);

export const hasAnyPermission = (
  access: EffectiveAccess,
  permissions: readonly Permission[],
): boolean => permissions.some((p) => access.permissions.includes(p));

export const hasAllPermissions = (
  access: EffectiveAccess,
  permissions: readonly Permission[],
): boolean => permissions.every((p) => access.permissions.includes(p));
