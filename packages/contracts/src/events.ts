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

/**
 * Which queue an event is dispatched to.
 *
 * ⚠️ EXHAUSTIVE FOR REAL. The type is `Record<DomainEvent, QueueName | null>`,
 * so adding an event to `DOMAIN_EVENTS` fails to compile until someone decides
 * where it goes. This used to be `Record<string, QueueName>` under a comment
 * claiming it was "exhaustive by construction", which it was not — a plain
 * string-keyed record checks nothing. Seven events accumulated in the gap:
 * `payment.verified`, `invoice.overdue` and `order.rejected` had working
 * handlers that were unreachable because nothing routed them, and four more
 * were routed to a processor with no case for them.
 *
 * `null` means "deliberately has no consumer" and is NOT the same as absent.
 * Absent was an oversight nobody could see; `null` is a decision on the record.
 * The dispatcher marks a null-routed event PROCESSED without enqueueing it.
 */
export const EVENT_QUEUE_ROUTING: Readonly<Record<DomainEvent, QueueName | null>> = {
  // ── Identity ────────────────────────────────────────────────────────────
  [DOMAIN_EVENTS.USER_INVITED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.USER_CREATED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.USER_PASSWORD_RESET_REQUESTED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.USER_PASSWORD_CHANGED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.USER_EMAIL_VERIFICATION_REQUESTED]: QUEUE_NAMES.EMAIL,
  /// Suspension is an administrative act the user is told about in person.
  [DOMAIN_EVENTS.USER_SUSPENDED]: null,

  // ── Security: ops channel, never business ───────────────────────────────
  [DOMAIN_EVENTS.SECURITY_TOKEN_REUSE_DETECTED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.SECURITY_ACCOUNT_LOCKED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.SECURITY_SENSITIVE_FIELD_CHANGED]: QUEUE_NAMES.EMAIL,
  /// Audited, and escalated by the error-spike monitor rather than per event —
  /// one denial is normal, a burst is not.
  [DOMAIN_EVENTS.SECURITY_PERMISSION_DENIED_REPEATEDLY]: null,

  // ── Channel ─────────────────────────────────────────────────────────────
  [DOMAIN_EVENTS.DISTRIBUTOR_APPROVED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.DISTRIBUTOR_CREATED]: null,
  [DOMAIN_EVENTS.DISTRIBUTOR_SUSPENDED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.DISTRIBUTOR_DOCUMENT_EXPIRING]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.DISTRIBUTOR_CREDIT_LIMIT_CHANGED]: QUEUE_NAMES.NOTIFICATIONS,

  // ── Catalog & pricing ───────────────────────────────────────────────────
  // Publishing a price list changes what every assigned partner pays, so it
  // notifies rather than merely being logged.
  [DOMAIN_EVENTS.PRICE_LIST_PUBLISHED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.DISTRIBUTOR_CATALOG_CHANGED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.PRODUCT_CREATED]: null,
  [DOMAIN_EVENTS.PRODUCT_STATUS_CHANGED]: null,
  [DOMAIN_EVENTS.PRODUCT_PRICE_AFFECTING_CHANGE]: null,
  [DOMAIN_EVENTS.PRICE_LIST_CLONED]: null,
  [DOMAIN_EVENTS.DISCOUNT_RULE_CHANGED]: null,
  [DOMAIN_EVENTS.TAX_RATE_SUPERSEDED]: null,

  // ── Sales ───────────────────────────────────────────────────────────────
  [DOMAIN_EVENTS.QUOTATION_SENT]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.QUOTATION_ACCEPTED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.ORDER_SUBMITTED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.ORDER_APPROVED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.ORDER_REJECTED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.ORDER_CANCELLED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.SHIPMENT_DISPATCHED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.SHIPMENT_DELIVERED]: QUEUE_NAMES.NOTIFICATIONS,

  // ── Finance ─────────────────────────────────────────────────────────────
  [DOMAIN_EVENTS.INVOICE_ISSUED]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.INVOICE_OVERDUE]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.PAYMENT_RECORDED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.PAYMENT_VERIFIED]: QUEUE_NAMES.NOTIFICATIONS,
  [DOMAIN_EVENTS.CREDIT_LIMIT_BREACHED]: QUEUE_NAMES.NOTIFICATIONS,

  // ── Inventory ───────────────────────────────────────────────────────────
  [DOMAIN_EVENTS.STOCK_LOW]: QUEUE_NAMES.NOTIFICATIONS,
  /// Ledger and balances disagreeing is an operator emergency, not partner news.
  [DOMAIN_EVENTS.STOCK_RECONCILIATION_DRIFT]: QUEUE_NAMES.EMAIL,
  [DOMAIN_EVENTS.STOCK_ADJUSTED]: null,

  // ── Reporting & integration ─────────────────────────────────────────────
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
