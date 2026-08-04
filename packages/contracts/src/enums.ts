import { z } from 'zod';

/**
 * Domain enums. These mirror the Postgres enums declared in the Prisma schema —
 * defined here so both apps and the database agree on one vocabulary.
 * Changes must be additive; removing a member is a breaking migration.
 */

const asEnum = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values);

// ── Identity ────────────────────────────────────────────────────────────────

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const userStatusSchema = asEnum(USER_STATUSES);

export const ACTOR_TYPES = ['USER', 'SYSTEM', 'API_KEY'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
export const actorTypeSchema = asEnum(ACTOR_TYPES);

export const AUDIT_CATEGORIES = ['AUTH', 'DATA', 'SECURITY', 'INTEGRATION'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export const auditCategorySchema = asEnum(AUDIT_CATEGORIES);

export const MFA_TYPES = ['TOTP', 'BACKUP_CODE'] as const;
export type MfaType = (typeof MFA_TYPES)[number];

// ── Channel ─────────────────────────────────────────────────────────────────

export const DISTRIBUTOR_TYPES = [
  'DISTRIBUTOR',
  'DEALER',
  'SYSTEM_INTEGRATOR',
  'OEM_PARTNER',
] as const;
export type DistributorType = (typeof DISTRIBUTOR_TYPES)[number];
export const distributorTypeSchema = asEnum(DISTRIBUTOR_TYPES);

export const DISTRIBUTOR_STATUSES = [
  'LEAD',
  'PENDING_APPROVAL',
  'ACTIVE',
  'SUSPENDED',
  'TERMINATED',
] as const;
export type DistributorStatus = (typeof DISTRIBUTOR_STATUSES)[number];
export const distributorStatusSchema = asEnum(DISTRIBUTOR_STATUSES);

/** Only ACTIVE distributors may transact. Enforced in the order service. */
export const TRANSACTABLE_DISTRIBUTOR_STATUSES: readonly DistributorStatus[] = ['ACTIVE'];

export const TERRITORY_TYPES = ['ZONE', 'REGION', 'STATE', 'DISTRICT'] as const;
export type TerritoryType = (typeof TERRITORY_TYPES)[number];
export const territoryTypeSchema = asEnum(TERRITORY_TYPES);

export const CUSTOMER_TYPES = [
  'INDUSTRIAL',
  'GOVERNMENT',
  'OEM',
  'INSTITUTIONAL',
  'INDIVIDUAL',
] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];
export const customerTypeSchema = asEnum(CUSTOMER_TYPES);

export const KYC_DOCUMENT_TYPES = [
  'GST_CERTIFICATE',
  'PAN_CARD',
  'AGREEMENT',
  'CANCELLED_CHEQUE',
  'MSME_CERT',
  'OTHER',
] as const;
export type KycDocumentType = (typeof KYC_DOCUMENT_TYPES)[number];

// ── Catalog ─────────────────────────────────────────────────────────────────

/**
 * Hixaa sells systems, not just SKUs — a Raksha IoT deployment is gateways +
 * tags + licences + commissioning. KIT/CONFIGURABLE exist for exactly that.
 */
export const PRODUCT_TYPES = ['GOODS', 'SERVICE', 'KIT', 'CONFIGURABLE'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];
export const productTypeSchema = asEnum(PRODUCT_TYPES);

export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'DISCONTINUED', 'ARCHIVED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const productStatusSchema = asEnum(PRODUCT_STATUSES);

export const PRODUCT_MEDIA_TYPES = [
  'IMAGE',
  'BROCHURE',
  'DATASHEET',
  'MANUAL',
  'CERTIFICATE',
  'VIDEO',
  'CAD',
] as const;
export type ProductMediaType = (typeof PRODUCT_MEDIA_TYPES)[number];
export const productMediaTypeSchema = asEnum(PRODUCT_MEDIA_TYPES);

export const PRICE_LIST_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type PriceListStatus = (typeof PRICE_LIST_STATUSES)[number];
export const priceListStatusSchema = asEnum(PRICE_LIST_STATUSES);

/**
 * Whether a price list's prices include tax. Hixaa quotes ex-GST — see
 * ADR-0008. Stored explicitly rather than assumed, because a column of numbers
 * carries no memory of which convention produced it.
 */
export const PRICE_BASES = ['EXCLUSIVE', 'INCLUSIVE'] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];
export const priceBasisSchema = asEnum(PRICE_BASES);

export const DISCOUNT_SCOPES = [
  'GLOBAL',
  'PRICE_LIST',
  'DISTRIBUTOR',
  'CATEGORY',
  'PRODUCT',
] as const;
export type DiscountScope = (typeof DISCOUNT_SCOPES)[number];
export const discountScopeSchema = asEnum(DISCOUNT_SCOPES);

/**
 * Tie-break when two rules share a `priority`: the more specific scope wins.
 * Declared as data so the pricing engine's ordering is inspectable and testable
 * rather than buried in a comparator. See ADR-0007 §3.
 */
export const DISCOUNT_SCOPE_SPECIFICITY: Readonly<Record<DiscountScope, number>> = {
  PRODUCT: 0,
  CATEGORY: 1,
  DISTRIBUTOR: 2,
  PRICE_LIST: 3,
  GLOBAL: 4,
};

export const DISCOUNT_TYPES = ['PERCENT', 'FLAT'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];
export const discountTypeSchema = asEnum(DISCOUNT_TYPES);

// ── Inventory ───────────────────────────────────────────────────────────────

export const WAREHOUSE_TYPES = ['COMPANY', 'DISTRIBUTOR', 'TRANSIT', 'SCRAP'] as const;
export type WarehouseType = (typeof WAREHOUSE_TYPES)[number];
export const warehouseTypeSchema = asEnum(WAREHOUSE_TYPES);

/** Every row in the immutable stock ledger carries one of these. See ADR-0002. */
export const STOCK_MOVEMENT_TYPES = [
  'OPENING',
  'RECEIPT',
  'ISSUE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'ADJUSTMENT',
  'SALES_RETURN',
  'SCRAP',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];
export const stockMovementTypeSchema = asEnum(STOCK_MOVEMENT_TYPES);

/** Movement types that increase stock. The ledger stores signed quantities. */
export const INBOUND_MOVEMENTS: readonly StockMovementType[] = [
  'OPENING',
  'RECEIPT',
  'TRANSFER_IN',
  'SALES_RETURN',
];

/**
 * Movement types that DECREASE stock. Declared alongside INBOUND_MOVEMENTS so
 * the sign a movement carries is derived from data rather than from a
 * conditional someone can get backwards. The database enforces the same rule
 * (`stock_ledger_sign_matches_type` in migration 0007).
 */
export const OUTBOUND_MOVEMENTS: readonly StockMovementType[] = [
  'ISSUE',
  'TRANSFER_OUT',
  'SCRAP',
];

/** ADJUSTMENT is the only type allowed either sign — that is what it is for. */
export const signForMovement = (type: StockMovementType): 1 | -1 | 0 => {
  if (INBOUND_MOVEMENTS.includes(type)) return 1;
  if (OUTBOUND_MOVEMENTS.includes(type)) return -1;
  return 0;
};

export const RESERVATION_STATUSES = ['ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export const reservationStatusSchema = asEnum(RESERVATION_STATUSES);

/**
 * A reservation leaves ACTIVE exactly once, and never returns. Re-activating a
 * consumed reservation would double-count stock that has already shipped.
 */
export const RESERVATION_TRANSITIONS: Readonly<
  Record<ReservationStatus, readonly ReservationStatus[]>
> = {
  ACTIVE: ['RELEASED', 'CONSUMED', 'EXPIRED'],
  RELEASED: [],
  CONSUMED: [],
  EXPIRED: [],
};

export const canTransitionReservation = (
  from: ReservationStatus,
  to: ReservationStatus,
): boolean => RESERVATION_TRANSITIONS[from].includes(to);

export const SERIAL_STATUSES = ['IN_STOCK', 'RESERVED', 'SOLD', 'RMA', 'SCRAPPED'] as const;
export type SerialStatus = (typeof SERIAL_STATUSES)[number];
export const serialStatusSchema = asEnum(SERIAL_STATUSES);

export const TRANSFER_STATUSES = ['DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];
export const transferStatusSchema = asEnum(TRANSFER_STATUSES);

/**
 * Two-phase by construction: stock cannot arrive without having been dispatched,
 * so RECEIVED is only reachable from IN_TRANSIT. That is what keeps transit
 * stock visible instead of goods appearing to vanish in the lorry.
 */
export const TRANSFER_TRANSITIONS: Readonly<Record<TransferStatus, readonly TransferStatus[]>> = {
  DRAFT: ['IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['RECEIVED'],
  RECEIVED: [],
  CANCELLED: [],
};

export const canTransitionTransfer = (from: TransferStatus, to: TransferStatus): boolean =>
  TRANSFER_TRANSITIONS[from].includes(to);

export const STOCK_COUNT_STATUSES = ['DRAFT', 'COUNTING', 'POSTED', 'CANCELLED'] as const;
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number];
export const stockCountStatusSchema = asEnum(STOCK_COUNT_STATUSES);

// ── Sales ───────────────────────────────────────────────────────────────────

export const ORDER_TYPES = ['PRIMARY', 'SECONDARY'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];
export const orderTypeSchema = asEnum(ORDER_TYPES);

export const ORDER_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PROCESSING',
  'PARTIALLY_DISPATCHED',
  'DISPATCHED',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
  'REJECTED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const orderStatusSchema = asEnum(ORDER_STATUSES);

/**
 * The order finite state machine, declared as data so illegal transitions are
 * rejected in one place with one test file rather than by scattered
 * if-statements. See docs/01-architecture.md §5.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['PARTIALLY_DISPATCHED', 'DISPATCHED', 'CANCELLED'],
  PARTIALLY_DISPATCHED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['DELIVERED'],
  DELIVERED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  REJECTED: ['DRAFT'],
};

export const canTransitionOrder = (from: OrderStatus, to: OrderStatus): boolean =>
  ORDER_TRANSITIONS[from].includes(to);

export const QUOTATION_STATUSES = [
  'DRAFT',
  'SENT',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'CONVERTED',
] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];
export const quotationStatusSchema = asEnum(QUOTATION_STATUSES);

/**
 * A quotation is a PROPOSAL, so its lifecycle is deliberately looser than an
 * order's — it can be re-sent, and a rejected one can be revised and sent again.
 * What it cannot do is go backwards from CONVERTED: once an order exists, the
 * quotation is history.
 */
export const QUOTATION_TRANSITIONS: Readonly<
  Record<QuotationStatus, readonly QuotationStatus[]>
> = {
  DRAFT: ['SENT', 'REJECTED'],
  SENT: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'SENT'],
  ACCEPTED: ['CONVERTED', 'REJECTED'],
  REJECTED: ['DRAFT'],
  EXPIRED: ['DRAFT'],
  // Terminal. An order exists; revising means a new quotation.
  CONVERTED: [],
};

export const canTransitionQuotation = (from: QuotationStatus, to: QuotationStatus): boolean =>
  QUOTATION_TRANSITIONS[from].includes(to);

/** Only these may be converted into an order. */
export const CONVERTIBLE_QUOTATION_STATUSES: readonly QuotationStatus[] = ['ACCEPTED'];

export const SHIPMENT_STATUSES = [
  'PENDING',
  'PACKED',
  'DISPATCHED',
  'IN_TRANSIT',
  'DELIVERED',
  'RETURNED',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
export const shipmentStatusSchema = asEnum(SHIPMENT_STATUSES);

/**
 * Stock leaves the building exactly once. DISPATCHED is reachable only from
 * PACKED, so a shipment cannot consume reservations twice — that would issue
 * the same stock into the ledger a second time.
 */
export const SHIPMENT_TRANSITIONS: Readonly<Record<ShipmentStatus, readonly ShipmentStatus[]>> = {
  PENDING: ['PACKED', 'RETURNED'],
  PACKED: ['DISPATCHED', 'PENDING'],
  DISPATCHED: ['IN_TRANSIT', 'DELIVERED', 'RETURNED'],
  IN_TRANSIT: ['DELIVERED', 'RETURNED'],
  DELIVERED: ['RETURNED'],
  RETURNED: [],
};

export const canTransitionShipment = (from: ShipmentStatus, to: ShipmentStatus): boolean =>
  SHIPMENT_TRANSITIONS[from].includes(to);

/** What an approval was granted against. Mirrors the Prisma enum. */
export const APPROVAL_KINDS = ['DISCOUNT', 'ORDER_VALUE', 'CREDIT_LIMIT'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export const approvalKindSchema = asEnum(APPROVAL_KINDS);

/**
 * Order statuses at which stock is committed and must be released if the order
 * dies. Declared as data so the cancel path cannot forget one.
 */
export const STOCK_COMMITTED_ORDER_STATUSES: readonly OrderStatus[] = [
  'APPROVED',
  'PROCESSING',
  'PARTIALLY_DISPATCHED',
];

/** An order past this point has moved goods and can no longer be cancelled. */
export const CANCELLABLE_ORDER_STATUSES: readonly OrderStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PROCESSING',
];

// ── Finance ─────────────────────────────────────────────────────────────────

export const INVOICE_TYPES = ['TAX_INVOICE', 'PROFORMA', 'CREDIT_NOTE', 'DEBIT_NOTE'] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];

export const INVOICE_STATUSES = [
  'DRAFT',
  'ISSUED',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'CANCELLED',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Once issued, an invoice is immutable — corrections go through a credit note. */
export const IMMUTABLE_INVOICE_STATUSES: readonly InvoiceStatus[] = [
  'ISSUED',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'CANCELLED',
];

export const SUPPLY_TYPES = ['B2B', 'B2C', 'SEZ', 'EXPORT'] as const;
export type SupplyType = (typeof SUPPLY_TYPES)[number];

export const PAYMENT_METHODS = [
  'NEFT',
  'RTGS',
  'IMPS',
  'UPI',
  'CHEQUE',
  'DD',
  'CASH',
  'ADJUSTMENT',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const paymentMethodSchema = asEnum(PAYMENT_METHODS);

export const PAYMENT_STATUSES = ['PENDING', 'CLEARED', 'BOUNCED', 'CANCELLED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_DIRECTIONS = ['INBOUND', 'OUTBOUND'] as const;
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

export const LEDGER_REF_TYPES = [
  'OPENING',
  'INVOICE',
  'PAYMENT',
  'CREDIT_NOTE',
  'DEBIT_NOTE',
  'ADJUSTMENT',
] as const;
export type LedgerRefType = (typeof LEDGER_REF_TYPES)[number];

export const NUMBER_RESET_POLICIES = ['NEVER', 'YEARLY', 'MONTHLY'] as const;
export type NumberResetPolicy = (typeof NUMBER_RESET_POLICIES)[number];

// ── Documents & storage ─────────────────────────────────────────────────────

export const STORAGE_PROVIDERS = ['LOCAL', 'S3'] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export const SCAN_STATUSES = ['PENDING', 'CLEAN', 'INFECTED', 'SKIPPED'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const DOCUMENT_VISIBILITIES = ['PUBLIC', 'INTERNAL', 'RESTRICTED'] as const;
export type DocumentVisibility = (typeof DOCUMENT_VISIBILITIES)[number];

// ── Messaging & integration ─────────────────────────────────────────────────

/**
 * The two email channels are separate transports. Business mail goes to
 * distributors and customers via Hostinger; ops mail goes to the operator via
 * Gmail. Templates are typed per channel so crossing them is a compile error.
 * See docs/07-integrations.md §1.
 */
export const MAIL_CHANNELS = ['BUSINESS', 'OPS'] as const;
export type MailChannel = (typeof MAIL_CHANNELS)[number];

export const EMAIL_STATUSES = ['QUEUED', 'SENT', 'FAILED', 'BOUNCED'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export const OUTBOX_STATUSES = ['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const SYNC_ENTITIES = [
  'USERS',
  'PRODUCTS',
  'DISTRIBUTORS',
  'ORDERS',
  'PAYMENTS',
  'INVENTORY',
] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

export const SYNC_MODES = ['SCHEDULED', 'MANUAL'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export const SYNC_DIRECTIONS = ['EXPORT', 'RESTORE'] as const;
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

export const SYNC_STATUSES = ['QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'PARTIAL'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const REPORT_FORMATS = ['PDF', 'XLSX', 'CSV'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export const reportFormatSchema = asEnum(REPORT_FORMATS);
