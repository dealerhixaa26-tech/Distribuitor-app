# ADR-0003 — Scoped RBAC enforced at the repository layer

- **Status:** Proposed (awaiting approval)
- **Date:** 2026-08-03

## Context

The Admin Portal ships in v1; the Distributor Portal follows, reusing the same backend. A
distributor user must see **only** their own orders, invoices, stock, and pricing. Internal users
are also bounded — a Sales Manager owns a territory, not the country.

Authorization therefore has two independent dimensions: *may this user perform this action* and
*on which records*.

## Decision

1. `Permission` answers "may they perform this action" — checked by a route guard
   (`@RequirePermission('order:approve')`).
2. `UserRole.scopeType` (`GLOBAL` | `TERRITORY` | `DISTRIBUTOR`) and `scopeId` answer "on which
   records".
3. The scope predicate is injected into **every query** by a Prisma client extension, keyed on each
   model's registered scope strategy. Bypassing requires an explicit `withoutScope()` call.
4. Out-of-scope reads return **404**, not 403, so the API is not an enumeration oracle.

Distributor users are ordinary `User` rows with a role assignment scoped to `DISTRIBUTOR:<id>`,
linked from `DistributorContact.portalUserId`. There is no second user table and no second auth
system.

## Consequences

**Positive**

- **Forgetting to filter is not possible.** A new endpoint calling `prisma.order.findMany({})`
  returns only in-scope rows by default. Safe-by-default beats remember-to-be-safe every time.
- The Distributor Portal becomes a frontend project, not a backend project: a new Next.js app, two
  seeded roles, and a link column that already exists.
- Internal territory scoping is the same mechanism, so it is exercised and tested from Phase 2 —
  long before the portal depends on it.
- Multi-scope users (West *and* Central) work without special cases.

**Negative**

- Extra indirection in the repository layer; developers must understand the extension.
- `withoutScope()` exists and could be misused — mitigated by making it explicit, greppable, and a
  code-review checkpoint.
- Scope resolution adds a small per-request cost (cached in Redis per session).

**Rejected: adding scoping later, when the portal is built.** Retrofitting row-level filters onto
~200 existing query sites means missing one. The failure mode is a distributor seeing a competitor's
pricing — precisely the incident that destroys trust in a channel platform.

**Rejected: a separate portal API.** Two codebases enforcing the same rules diverge, and the
duplication contradicts the requirement that the portal reuse the existing backend.
