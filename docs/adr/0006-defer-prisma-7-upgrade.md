# ADR-0006 — Defer the Prisma 7 upgrade

- **Status:** Accepted
- **Date:** 2026-08-04
- **Supersedes:** the recommendation in `docs/13-phase-1-completion.md` §6

## Context

At the end of Phase 1 I recommended upgrading Prisma 6.19 → 7.x at the start of Phase 2, on
the reasoning that it would be the cheapest possible moment: one schema file, no query code
yet, all database access behind repositories.

Before starting Phase 2 I checked what the upgrade actually involves. It is materially larger
than that reasoning assumed.

Prisma 7 requires:

1. **Driver adapters are mandatory.** `PrismaClient` must be constructed with an adapter
   (`@prisma/adapter-pg` plus `pg`). This changes instantiation, connection pooling
   semantics, and the per-session `statement_timeout` we set on connect.
2. **A new generator.** `prisma-client-js` is replaced by `prisma-client`, with a mandatory
   `output` path.
3. **Changed import paths.** `@prisma/client` becomes a generated relative path, touching
   every importing file plus both Dockerfiles.
4. **Relocated internals.** `Prisma.dmmf`, `Prisma.Decimal`, `Prisma.PrismaClientKnownRequestError`
   and `Prisma.InputJsonValue` all need re-verification.

Item 4 is the sharp edge. Those are load-bearing here, not incidental:

| Dependency | Used by |
|---|---|
| `Prisma.dmmf.datamodel.models` | The soft-delete extension derives its model list from the schema, so adding `deletedAt` enrols a model automatically (ADR-0002 support) |
| `Prisma.Decimal` | The transform interceptor converts Decimal → string so money never becomes a JSON number (ADR-0004) |
| `Prisma.PrismaClientKnownRequestError` | The exception filter maps database errors to RFC 7807 without leaking internals |

## Decision

**Stay on Prisma 6.19.3 for Phase 2.** Revisit at Phase 11 (Hardening), or sooner if a
Prisma 7 feature is actually needed.

## Consequences

**Positive**

- Phase 2 effort goes into authentication — the phase's actual deliverable — rather than
  into a framework migration with no user-visible benefit.
- Prisma 6 is a supported major on a stable release line.
- The three mechanisms above stay verified rather than being re-proven mid-migration.

**Negative**

- The upgrade gets more expensive with every module. Mitigated by the fact that all database
  access sits behind repositories and the two client extensions — the blast radius stays
  bounded by design, which is what made that layering worth building in the first place.
- We are one major version behind, and Prisma 6 will eventually stop receiving fixes.

**Revisit trigger** — any of: a security advisory against Prisma 6, a needed Prisma 7 feature,
or the start of Phase 11.

## Note on the reversal

I recommended the opposite two days of work ago, on an assumption I had not yet checked. The
driver-adapter requirement is the fact that changed the answer. Recording it here rather than
quietly dropping the recommendation, because the reasoning matters more than the conclusion:
"cheapest now" is only true when the migration is small, and this one is not.
