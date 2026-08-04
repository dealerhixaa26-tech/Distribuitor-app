# ADR-0001 — Monorepo with a shared contracts package

- **Status:** Proposed (awaiting approval)
- **Date:** 2026-08-03
- **Deciders:** Sidhant (Hixaa Technologies)

## Context

The system is a NestJS API plus a Next.js admin web app, with a second frontend (the Distributor
Portal) and possibly mobile clients arriving later. All of them exchange the same DTOs, enums,
validation rules, and permission keys.

The two conventional options are separate repositories with a published types package, or a
monorepo.

## Decision

A **pnpm workspace monorepo** orchestrated by **Turborepo**, containing `apps/api`, `apps/web`, and
a shared `packages/contracts` package.

`packages/contracts` holds **Zod schemas** as the single definition of every request and response
shape, plus enums and permission key constants. It is consumed by:

- NestJS `ZodValidationPipe` — runtime request validation
- `nestjs-zod` / `zod-to-openapi` — OpenAPI schema generation
- React Hook Form's Zod resolver — client-side validation
- Both apps' TypeScript — via `z.infer`

## Consequences

**Positive**

- A validation rule cannot disagree between client and server, because there is one rule.
- Atomic cross-stack changes: an endpoint and its consumer change in one commit and one review.
- The OpenAPI spec cannot drift from the implementation; CI fails if the committed spec differs
  from the generated one.
- Adding `apps/portal` in v2 costs nothing — it imports the same contracts.
- Turborepo's cache means CI rebuilds only what changed.

**Negative**

- A larger initial setup than two `create-*-app` commands.
- Contributors clone the whole workspace.
- Turborepo pipeline configuration is a thing that must be maintained.

**Rejected: separate repos with a published `@hixaa/types` package.** Every contract change becomes
publish → bump → install across two repos, and in practice the version lag means client and server
disagree for hours or days at a time. That is precisely the bug class this decision eliminates.

**Rejected: Nx.** More capable, but heavier than a two-app workspace needs. Turborepo's smaller
surface is the better fit here.
