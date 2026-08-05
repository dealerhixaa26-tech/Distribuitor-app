import { DOMAIN_EVENTS, EVENT_QUEUE_ROUTING, QUEUE_NAMES } from '@hixaa/contracts';
import { PinoLogger } from 'nestjs-pino';
import { NotificationsProcessor } from './notifications.processor';
import { EVENT_AUDIENCE } from '../modules/intelligence/notifications.service';

/**
 * The end-to-end wiring of an event, asserted as data.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * An event has to clear THREE independent hurdles to reach a person, and it was
 * silently failing at each of them in a different place:
 *
 *   1. `EVENT_QUEUE_ROUTING` must send it to a queue.
 *   2. The processor for that queue must have a case for it.
 *   3. For notifications, `EVENT_AUDIENCE` must map it to a permission.
 *
 * Every one of those three was keyed by hand, two of them by STRING LITERAL,
 * and nothing checked that they agreed. What that cost, found in Phase 10 by
 * pushing real events through a real worker:
 *
 *   • `inventory.stock_low` — `describe()` matched the literal 'stock.low',
 *     and `EVENT_AUDIENCE` ALSO keyed 'stock.low'. Two independent copies of
 *     the same typo, one function apart, so fixing either alone changed
 *     nothing. Every low-stock alert since Phase 6 was discarded.
 *   • `distributor.catalog_changed` — `EVENT_AUDIENCE` keyed
 *     'distributor.catalog.changed', dots for the underscore. Silently no
 *     audience, forever.
 *   • `payment.verified`, `invoice.overdue`, `order.rejected` — handlers
 *     written and never routed, so unreachable.
 *   • `quotation.sent`, `invoice.issued`, `distributor.approved`,
 *     `inventory.reconciliation_drift` — routed to the email queue, which had
 *     no case for any of them, so they hit `default:` and vanished.
 *
 * None of it failed. All of it succeeded, doing nothing, which is why four
 * phases went by. These tests make the three tables prove they agree.
 */

/** A processor instance is only needed to reach `describe`; nothing is called. */
function describeFor(eventType: string): unknown {
  const logger = { setContext: () => undefined, debug: () => undefined } as unknown as PinoLogger;
  const processor = new NotificationsProcessor(
    null as never,
    null as never,
    logger,
  ) as unknown as {
    describe: (t: string, p: Record<string, unknown>, id: string) => unknown;
  };
  return processor.describe(eventType, {}, 'test-aggregate-id');
}

const routed = Object.entries(EVENT_QUEUE_ROUTING) as Array<
  [string, (typeof EVENT_QUEUE_ROUTING)[keyof typeof EVENT_QUEUE_ROUTING]]
>;

const declaredEvents = new Set<string>(Object.values(DOMAIN_EVENTS));

describe('event plumbing — the routing table is complete', () => {
  it('routes every declared domain event, explicitly', () => {
    // `null` is a decision; ABSENT is an oversight. The type enforces this at
    // compile time; this asserts it at runtime too, so a cast cannot slip past.
    const missing = [...declaredEvents].filter(
      (event) => !Object.hasOwn(EVENT_QUEUE_ROUTING, event),
    );
    expect(missing).toEqual([]);
  });

  it('routes to no queue that does not exist', () => {
    const queues = new Set<string>(Object.values(QUEUE_NAMES));
    const bad = routed.filter(([, queue]) => queue !== null && !queues.has(queue));
    expect(bad).toEqual([]);
  });

  it('names only declared domain events as keys', () => {
    const undeclared = routed.map(([event]) => event).filter((e) => !declaredEvents.has(e));
    expect(undeclared).toEqual([]);
  });
});

describe('event plumbing — a routed event has somewhere to land', () => {
  const toNotifications = routed
    .filter(([, queue]) => queue === QUEUE_NAMES.NOTIFICATIONS)
    .map(([event]) => event);

  it.each(toNotifications)('%s has a notification message', (event) => {
    // The `inventory.stock_low` bug: routed here, and `describe()` returned
    // null because it matched a literal that no constant produces.
    expect(describeFor(event)).not.toBeNull();
  });

  it.each(toNotifications)('%s has an audience mapped', (event) => {
    // The second, independent copy of the same bug. A message with no audience
    // is composed and then thrown away.
    expect(EVENT_AUDIENCE[event as keyof typeof EVENT_AUDIENCE]).toBeDefined();
  });

  it('maps an audience only for events that actually reach the queue', () => {
    // Catches the reverse drift: an audience entry whose key is misspelled, or
    // left behind after an event was rerouted, is dead configuration that reads
    // as coverage.
    const strays = Object.keys(EVENT_AUDIENCE).filter((event) => {
      if (!declaredEvents.has(event)) return true;
      const queue = EVENT_QUEUE_ROUTING[event as keyof typeof EVENT_QUEUE_ROUTING];
      // invoice.issued is deliberately routed to EMAIL for its PDF; its
      // notification case is retained and documented as unreachable.
      return queue !== QUEUE_NAMES.NOTIFICATIONS && event !== DOMAIN_EVENTS.INVOICE_ISSUED;
    });
    expect(strays).toEqual([]);
  });
});
