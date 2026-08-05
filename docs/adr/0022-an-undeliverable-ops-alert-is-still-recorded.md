# ADR-0022 — An ops alert that cannot be delivered is still recorded

- **Status:** Accepted
- **Date:** 2026-08-05

## Context

`MailService.sendOps()` begins:

```ts
const recipient = this.config.mailOps.to;
if (!recipient) {
  this.logger.warn({ template }, 'MAIL_OPS_TO is not configured; ops alert not sent');
  return;
}
```

The early return happens **before** `dispatch()`, which is what writes the `EmailLog` row. So an
unconfigured ops channel does not produce a failed send — it produces no evidence of any kind.

`MAIL_OPS_TO`, `MAIL_OPS_USER` and `MAIL_OPS_FROM_ADDRESS` are all empty in the current
environment. Every ops alert in the system therefore evaporates: queue depth, dead letters, health
checks, backup reports, and security events.

This was demonstrated, not inferred. A `security.token_reuse_detected` event pushed through the
real outbox produced this and nothing else:

```
WARN: MAIL_OPS_TO is not configured; ops alert not sent {"template":"security-alert"}
```

`EmailLog` gained no row. That event means a rotated refresh token was replayed — the signature of
token theft, severity `critical` in the handler's own words. The system detected it, revoked the
token family, and then failed to record that it had tried to tell anyone.

## Decision

**`sendOps()` writes its `EmailLog` row first, then attempts delivery.** When no recipient is
configured the row is written with status `UNDELIVERABLE` and a reason, and the method returns
without throwing.

The alert becomes durable evidence independent of whether the transport is usable. "What did the
system try to tell me while the channel was misconfigured?" becomes a query rather than an
archaeology exercise over log files that have since rotated.

Two supporting constraints:

- **Outside development, an empty `MAIL_OPS_TO` fails at boot.** The ClamAV and S3 drivers already
  set this precedent: they throw at boot when selected rather than degrading silently
  (HANDOFF §8). A production deployment with no ops recipient is a misconfiguration, and it should
  be loud at the moment it is introduced, not at the moment it is needed.
- **Development keys on `NODE_ENV`, not on missing credentials.** Both channels use `LogTransport`
  in development so no real mail can leave a developer's machine (`docs/07` §1). Today the fallback
  triggers on absent credentials, which means the current `.env` — pointing the business channel at
  `smtp.hostinger.com` as `noreply@hixaa.com` — is one filled-in password away from sending real
  mail to real customers from a laptop.

## Why this is not over-engineering

This project's characteristic defect is not a crash. It is a component that succeeds while doing
nothing, and stays that way for phases:

- The worker did not boot for three phases; its only symptom was work not happening.
- `pnpm dev` never started the worker; the documented remedy for the above pointed at a command
  that could not perform it.
- Every background job read an empty database and reported success (ADR-0021); the nightly drift
  alarm was structurally unable to fire.

Each of those survived because *nothing was recorded when nothing happened*. An alerting path whose
own failure mode is silence reproduces the exact pattern, inside the machinery whose job is to
prevent it. The alerting system is the last place that failure mode is acceptable.

## Consequences

- `EmailLog` gains an `UNDELIVERABLE` status. The channel column already exists, so ops and business
  failures stay distinguishable in data.
- An ops alert never throws on a missing recipient. Callers are cron jobs and processors, and a
  misconfigured mailbox must not fail a stock reconciliation.
- Undeliverable alerts accumulate visibly, which is the intent: a growing count is the signal that
  the channel needs configuring, and it is available to the monitoring in 10.4.
- The retention purge deletes `EmailLog` rows with status `SENT` older than 90 days. `UNDELIVERABLE`
  rows are deliberately **not** purged on that path — an unread alert is not spent.
