/**
 * Domain events published through the transactional outbox. See ADR-0005.
 *
 * Every event name is declared here so a producer and a consumer cannot drift.
 * Adding a consumer means subscribing to an existing event, not editing the
 * business service that raises it.
 */

export const DOMAIN_EVENTS = {
  // Identity
  USER_INVITED: 'user.invited',
  USER_CREATED: 'user.created',
  USER_SUSPENDED: 'user.suspended',
  USER_PASSWORD_RESET_REQUESTED: 'user.password_reset_requested',
  USER_PASSWORD_CHANGED: 'user.password_changed',
  USER_EMAIL_VERIFICATION_REQUESTED: 'user.email_verification_requested',

  // Security — these additionally raise an OPS alert
  SECURITY_TOKEN_REUSE_DETECTED: 'security.token_reuse_detected',
  SECURITY_ACCOUNT_LOCKED: 'security.account_locked',
  SECURITY_SENSITIVE_FIELD_CHANGED: 'security.sensitive_field_changed',
  SECURITY_PERMISSION_DENIED_REPEATEDLY: 'security.permission_denied_repeatedly',

  // Channel
  DISTRIBUTOR_CREATED: 'distributor.created',
  DISTRIBUTOR_APPROVED: 'distributor.approved',
  DISTRIBUTOR_SUSPENDED: 'distributor.suspended',
  DISTRIBUTOR_DOCUMENT_EXPIRING: 'distributor.document_expiring',
  DISTRIBUTOR_CREDIT_LIMIT_CHANGED: 'distributor.credit_limit_changed',

  // Catalog & pricing
  PRODUCT_CREATED: 'product.created',
  PRODUCT_STATUS_CHANGED: 'product.status_changed',
  /// Raised when a product's price-affecting fields change, so anything holding
  /// a stale quotation can be re-priced rather than silently going out of date.
  PRODUCT_PRICE_AFFECTING_CHANGE: 'product.price_affecting_change',
  PRICE_LIST_PUBLISHED: 'pricelist.published',
  PRICE_LIST_CLONED: 'pricelist.cloned',
  DISCOUNT_RULE_CHANGED: 'discount.rule_changed',
  TAX_RATE_SUPERSEDED: 'tax.rate_superseded',
  DISTRIBUTOR_CATALOG_CHANGED: 'distributor.catalog_changed',

  // Sales
  QUOTATION_SENT: 'quotation.sent',
  QUOTATION_ACCEPTED: 'quotation.accepted',
  ORDER_SUBMITTED: 'order.submitted',
  ORDER_APPROVED: 'order.approved',
  ORDER_REJECTED: 'order.rejected',
  ORDER_CANCELLED: 'order.cancelled',
  SHIPMENT_DISPATCHED: 'shipment.dispatched',
  SHIPMENT_DELIVERED: 'shipment.delivered',

  // Finance
  INVOICE_ISSUED: 'invoice.issued',
  INVOICE_OVERDUE: 'invoice.overdue',
  PAYMENT_RECORDED: 'payment.recorded',
  PAYMENT_VERIFIED: 'payment.verified',
  CREDIT_LIMIT_BREACHED: 'finance.credit_limit_breached',

  // Inventory
  STOCK_LOW: 'inventory.stock_low',
  STOCK_ADJUSTED: 'inventory.stock_adjusted',
  STOCK_RECONCILIATION_DRIFT: 'inventory.reconciliation_drift',

  // Reporting & integration
  REPORT_READY: 'report.ready',
  SHEETS_SYNC_COMPLETED: 'backup.sheets_sync_completed',
  SHEETS_SYNC_FAILED: 'backup.sheets_sync_failed',
} as const;

export type DomainEvent = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

/** BullMQ queue names. Kept here so producer and processor cannot disagree. */
export const QUEUE_NAMES = {
  EMAIL: 'email',
  NOTIFICATIONS: 'notifications',
  SHEETS_SYNC: 'sheets-sync',
  REPORTS: 'reports',
  MAINTENANCE: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Which queue an event is dispatched to. Exhaustive by construction. */
export const EVENT_QUEUE_ROUTING: Readonly<Record<string, QueueName>> = {
  [DOMAIN_EVENTS.USER_INVITED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.USER_CREATED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.USER_PASSWORD_RESET_REQUESTED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.USER_PASSWORD_CHANGED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.USER_EMAIL_VERIFICATION_REQUESTED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.SECURITY_TOKEN_REUSE_DETECTED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.SECURITY_ACCOUNT_LOCKED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.SECURITY_SENSITIVE_FIELD_CHANGED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.DISTRIBUTOR_APPROVED]: QUEUE_NAMES.EMAIL,
  // Publishing a price list changes what every assigned partner pays, so it
  // notifies rather than merely being logged.
  [DOMAIN_EVENTS.PRICE_LIST_PUBLISHED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.DISTRIBUTOR_CATALOG_CHANGED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.QUOTATION_SENT]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.ORDER_APPROVED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.ORDER_SUBMITTED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.SHIPMENT_DISPATCHED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.INVOICE_ISSUED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.PAYMENT_RECORDED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.STOCK_LOW]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.STOCK_RECONCILIATION_DRIFT]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.REPORT_READY]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.SHEETS_SYNC_COMPLETED]: QUEUE_NAMES.MAINTENANCE,
  [DOMAIN_EVENTS.SHEETS_SYNC_FAILED]: QUEUE_NAMES.EMAIL,
};

export interface OutboxPayload {
  eventType: DomainEvent;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  /** Present when the event was raised by a request, absent for system jobs. */
  actorUserId?: string | null;
  requestId?: string | null;
}
