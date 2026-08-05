# ADR-0021 — The SYSTEM principal reads unscoped

- **Status:** Accepted
- **Date:** 2026-08-05
- **Amends:** ADR-0003 (scoped RBAC at the repository layer)

## Context

`applyScope()` decided what a caller may read using three branches:

```ts
if (!context || context.bypassScope) return args;   // 1. unfiltered
const access = context.access;
if (!access) return { where: { id: { in: [] } } };   // 2. nothing
const predicate = scopeFor(model)?.build(access);    // 3. the caller's scope
```

Branch 2 was written for a specific threat: an **unauthenticated HTTP request** must read nothing
rather than everything. That is right, and it stays.

The problem is that `RequestContextStore.asSystem()` — which every background job runs inside —
produces a context of exactly that shape. `actorType: 'SYSTEM'`, no `access`, no `bypassScope`.
Branch 1 was never reached, because a context *did* exist; branch 3 was never reached, because
there was no `access`. Every background job therefore read `id IN ()`.

The irony is precise: had the cron jobs run with **no context at all**, they would have worked.
Establishing a system identity — done so that an audit row is never anonymous — is what blinded
them.

## What this actually cost

Found in Phase 10 by running each job twice, once as the cron runs it and once with scope
bypassed, and comparing the counts:

```
as the cron runs it:      checked 0, clean=true
with scope bypassed:      checked 2, clean=true
actually in the table:    2
```

Three jobs, all reading scoped models, all silently empty:

- **`reconcileStock`** — ADR-0002's drift alarm. It re-derives every balance from the ledger and
  reports disagreement. It checked zero balances and reported `clean`. **It was structurally
  incapable of ever firing**, and would have reported success forever.
- **`expireStaleReservations`** — never released stock held behind an abandoned order.
- **`alertLowStock`** — never alerted. On the first run after the fix it raised **two real
  alerts** that had been suppressed: `HTPL-RAKSHA-TAG` at 0 against a reorder level of 100, and
  `HTPL-DAQ-16` at 0 against 2, both at WH-NGP.

None of this failed. All of it *succeeded*, over nothing. That is the recurring shape of every
serious defect in this project: not a crash, but a green result computed from an empty set.

It also blocked Phase 10 directly. Four of the six Google Sheets backup entities — Distributors,
Orders, Payments, Inventory — are scoped models. A backup job running under `asSystem` would have
exported **zero rows for four of six entities and recorded a successful sync**: the
"backup that manufactures false confidence" `docs/07` §2 warns about, arriving through a door
nobody was watching.

## Decision

**Treat a SYSTEM principal as unscoped, in the extension.**

```ts
if (!context || context.bypassScope) return args;
if (context.actorType === 'SYSTEM') return args;     // ← new
```

A background job has no user and no territory, and the whole dataset is exactly its legitimate
remit — reconciling every balance against the ledger is meaningless over a subset. "System" and
"unauthenticated" are different principals and must stop sharing a branch.

## Why this is safe

The asymmetry that makes it safe is that `actorType` has exactly one writer:

- `actorType: 'SYSTEM'` is set **only** by `RequestContextStore.asSystem()`.
- `request-context.middleware.ts` sets `actorType: 'USER'` on every HTTP request, authenticated
  or not.

So **no request path can reach the new branch**. An unauthenticated request still carries
`actorType: 'USER'` with no `access`, falls to branch 2, and reads nothing — unchanged.

Two tests in `scope.extension.spec.ts` are a matched pair and must be read together: one asserts
a SYSTEM context is unfiltered, the other asserts an unauthenticated USER context still resolves
to `id IN ()`. The second is the control that must not move.

## Alternatives considered

**Wrap each job body in `RequestContextStore.withoutScope()`.** This was the intended design —
`withoutScope`'s own docstring says it is "used by seeds, **reconciliation jobs**, and
cross-territory reports," and the escape is deliberately greppable so each bypass stays a
reviewable decision.

It was rejected on evidence. That convention already existed and was missed at **all three**
inventory jobs. A rule documented in a docstring, which the only three call sites that needed it
did not follow, is not a rule that holds. Phase 10 adds several more background jobs — including
the Sheets backup, whose failure mode is a silent empty export — and each would have to remember
it.

`withoutScope` remains, for the one case it genuinely fits: `access.service.ts` resolving a user's
own effective access, where a USER context must deliberately read past its own scope.

## Consequences

- Background jobs are now unscoped **by default**. This is correct for what SYSTEM means, but it
  is implicit rather than announced at the call site — the acknowledged cost of this decision.
  A future job that should *not* see everything must scope itself explicitly.
- Anything that reads through `prisma.db` inside `asSystem` changes behaviour. That is the point,
  but it means Phase 10's smoke suite must assert on **row counts**, never merely on a job
  succeeding.
- `apps/api/src/scripts/verify-worker-jobs.ts` is the regression harness: it runs each job twice,
  with and without the bypass, and fails when the two disagree. A job that silently loses its view
  of the database fails the build rather than passing quietly.
