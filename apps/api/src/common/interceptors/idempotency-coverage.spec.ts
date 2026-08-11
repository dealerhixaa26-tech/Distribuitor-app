import 'reflect-metadata';
import { IDEMPOTENT_KEY } from '../decorators/idempotent.decorator';
import { hashBody } from './idempotency.interceptor';
import { DistributorsController } from '../../modules/distributors/distributors.controller';
import {
  CreditNotesController,
  DebitNotesController,
  InvoicesController,
  PaymentsController,
} from '../../modules/finance/finance.controller';
import { OrdersController } from '../../modules/sales/sales.controller';

/**
 * `docs/03-api-design.md` §5, made checkable.
 *
 * The promise — idempotency on every request that moves money or commits an
 * irreversible decision — was structural only until Phase 11: the table, the
 * error code, the purge job, the CORS allowance and the client option all
 * existed, and no interceptor read the header.
 *
 * The failure mode this guards is the quiet one. Someone adds a new
 * money-moving POST, forgets `@Idempotent()`, and nothing breaks: the endpoint
 * works, the tests pass, and a retried request creates a second payment. So
 * the required set is declared here and read back off the controller metadata.
 * Adding a handler to this list without decorating it fails the build.
 *
 * Metadata, not source text: a `grep` for `@Idempotent` would be satisfied by
 * the decorator appearing in a comment.
 */

/* eslint-disable @typescript-eslint/no-unsafe-function-type */
type ControllerClass = { prototype: object; name: string };

// Route first, so a failure names the endpoint rather than printing a class.
const REQUIRED: Array<[string, ControllerClass, string]> = [
  // docs/03 §5 names orders, payments, invoices, and every /approve action.
  ['POST /orders', OrdersController, 'create'],
  ['POST /orders/from-quotation/:quotationId', OrdersController, 'fromQuotation'],
  ['POST /orders/:id/approve', OrdersController, 'approve'],
  ['POST /invoices', InvoicesController, 'create'],
  ['POST /invoices/from-order/:orderId', InvoicesController, 'fromOrder'],
  ['POST /invoices/from-shipment/:shipmentId', InvoicesController, 'fromShipment'],
  ['POST /payments', PaymentsController, 'create'],
  ['POST /distributors/:id/approve', DistributorsController, 'approve'],

  // Beyond the document, and deliberately so. These are the acts that actually
  // consume a statutory number or post to the ledger — a duplicate here is
  // worse than a duplicate DRAFT, and a gapless GST series cannot be
  // renumbered (HANDOFF §4.19).
  ['POST /invoices/:id/issue — burns a statutory number', InvoicesController, 'issue'],
  ['POST /credit-notes', CreditNotesController, 'create'],
  ['POST /credit-notes/:id/issue — statutory number', CreditNotesController, 'issue'],
  ['POST /debit-notes', DebitNotesController, 'create'],
  ['POST /debit-notes/:id/issue — statutory number', DebitNotesController, 'issue'],
  ['POST /payments/:id/verify — the financial event (ADR-0018)', PaymentsController, 'verify'],
  ['POST /payments/:id/allocate', PaymentsController, 'allocate'],
];

const isIdempotent = (controller: ControllerClass, method: string): boolean => {
  const handler = (controller.prototype as Record<string, unknown>)[method];
  if (typeof handler !== 'function') {
    throw new Error(`${controller.name}.${method}() does not exist — the list below is stale.`);
  }
  return Reflect.getMetadata(IDEMPOTENT_KEY, handler) === true;
};

describe('idempotency coverage', () => {
  it.each(REQUIRED)('%s requires an Idempotency-Key', (_route, controller, method) => {
    expect(isIdempotent(controller, method)).toBe(true);
  });

  it('does not mark reads, which would demand a header for a GET', () => {
    expect(isIdempotent(OrdersController, 'list')).toBe(false);
    expect(isIdempotent(InvoicesController, 'list')).toBe(false);
  });

  it('leaves reversible actions alone', () => {
    // Cancelling twice is harmless and the second is already refused by status;
    // demanding a key would be ceremony without a hazard behind it.
    expect(isIdempotent(OrdersController, 'cancel')).toBe(false);
  });
});

describe('request fingerprinting', () => {
  it('treats a body re-serialised in a different key order as the same request', () => {
    // Otherwise an honest retry from a client whose JSON serialiser reorders
    // keys is refused with a 409 the caller can do nothing about.
    expect(hashBody({ a: 1, b: { c: 2, d: 3 } })).toBe(hashBody({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('separates bodies that differ anywhere', () => {
    expect(hashBody({ amount: '100.0000' })).not.toBe(hashBody({ amount: '100.00' }));
    expect(hashBody({ lines: [{ q: 1 }] })).not.toBe(hashBody({ lines: [{ q: 2 }] }));
  });

  it('does not confuse array order, which is meaningful in a document', () => {
    expect(hashBody([1, 2])).not.toBe(hashBody([2, 1]));
  });

  it('treats an absent key and an undefined one alike', () => {
    expect(hashBody({ a: 1 })).toBe(hashBody({ a: 1, b: undefined }));
  });
});
