# ADR-0005 — Transactional outbox for all side effects

- **Status:** Proposed (awaiting approval)
- **Date:** 2026-08-03

## Context

Business operations trigger side effects: order-confirmation emails, in-app notifications, Google
Sheets backup rows, PDF generation, and later webhooks. Two requirements constrain how these run:

1. *"Never slow down API requests because of Google Sheets."*
2. A side effect must never announce something that did not actually happen.

Calling these services inline creates both failure modes: a slow SMTP handshake or a Sheets `429`
adds seconds to a user's request, and an email sent before a transaction rolls back tells a
distributor their order was confirmed when no order exists.

## Decision

Services write an **`outbox_event`** row **inside the same database transaction** as the business
change. A dispatcher worker polls for `PENDING` rows and publishes them to the appropriate BullMQ
queue. Processors are idempotent and keyed by event ID.

```ts
await this.prisma.$transaction(async (tx) => {
  const order = await this.orderRepo.approve(tx, id);
  await this.inventory.reserve(tx, order.lines);
  await this.outbox.emit(tx, 'order.approved', order.id, payload);   // same tx
});
// commit → dispatcher picks it up → BullMQ → email / sheets / notification
```

The dispatcher polls a partial index — `(status, available_at) WHERE status IN ('PENDING','FAILED')`
— so the query stays fast regardless of table size. Processed rows are purged after 90 days.

## Consequences

**Positive**

- **Atomicity.** If the transaction rolls back, the event vanishes with it. No email for a
  non-existent order, ever.
- **No third-party call is on the request path.** Google Sheets, SMTP, and PDF generation cannot
  affect API latency. This is the direct mechanism satisfying requirement (1).
- **At-least-once delivery** with retries, exponential backoff, and a dead-letter queue.
- **Auditable.** Every side effect that was supposed to happen is a durable row with its status,
  attempt count, and last error.
- Adding a consumer (webhooks, SMS) means subscribing to existing events, not editing business
  services.

**Negative**

- One extra table and a polling loop (~1 s interval; negligible load with the partial index).
- At-least-once means processors must be idempotent — enforced by convention and tested.
- Slight delivery latency (typically under two seconds), which is irrelevant for email and backups.

**Rejected: direct calls inside the service.** Violates both requirements above.

**Rejected: fire-and-forget `queue.add()` after commit.** The gap between commit and enqueue is a
lost event if the process dies there — rare, but silent and unrecoverable when it happens.

**Rejected: Postgres `LISTEN/NOTIFY` instead of polling.** Lower latency, but notifications are not
durable — a disconnected listener misses events permanently. Polling a partial index is boring,
cheap, and cannot lose anything.
