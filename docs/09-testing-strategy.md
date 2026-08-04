# 09 — Testing Strategy

> Phase 0 deliverable. Status: **Awaiting approval**

---

## 1. Shape of the suite

```
        ╱╲          E2E (Playwright)              ~40 specs
       ╱  ╲         critical user journeys only
      ╱────╲        Integration (Jest + Testcontainers)   ~250 specs
     ╱      ╲       real Postgres, real Redis, HTTP layer
    ╱────────╲      Unit (Jest / Vitest)          ~800 specs
   ╱__________╲     domain logic, calculators, state machines
```

The middle layer is deliberately the thickest relative to typical projects. In a system whose
correctness lives in **transactions, constraints, and row locks**, a mocked-Prisma unit test proves
almost nothing — it verifies that we called the mock we wrote. Integration tests against a real
Postgres are where inventory and money bugs are actually caught.

---

## 2. Layers

### Unit — pure logic, no I/O
Targets: `GstCalculator`, `Money`, pricing resolution, discount priority, order status machine,
aging buckets, credit-limit rules, GSTIN/PAN validators, pagination cursor encoding, permission
resolution.

```ts
describe('GstCalculator', () => {
  it('splits CGST/SGST for intra-state supply', () => {
    const r = calc.compute({ taxable: money('10000'), rate: 18, supplier: '27', pos: '27' });
    expect(r.cgst.toString()).toBe('900.0000');
    expect(r.sgst.toString()).toBe('900.0000');
    expect(r.igst.toString()).toBe('0.0000');
  });

  it('charges IGST for inter-state supply', () => {
    const r = calc.compute({ taxable: money('10000'), rate: 18, supplier: '27', pos: '29' });
    expect(r.igst.toString()).toBe('1800.0000');
    expect(r.cgst.toString()).toBe('0.0000');
  });

  it('never loses a paisa to rounding across a multi-line invoice', () => {
    // property test: sum(line taxes) + roundOff === invoice total, for 1000 random invoices
  });
});
```

That last one is a **property-based test** (`fast-check`). Rounding bugs in tax hide in specific
value combinations that example-based tests never happen to pick.

### Integration — real database, real HTTP
Spun up per suite with **Testcontainers**: a genuine Postgres 16 and Redis 7. Migrations run, seeds
load, each test runs in a transaction that is rolled back afterwards.

What is tested here:
- Every endpoint's happy path, validation failures, and authorization failures.
- **Scope isolation** — a West-territory user genuinely cannot read a Central distributor. This is
  asserted for every scoped resource, because it is the control that protects the future portal.
- **Transactional integrity** — a failure mid-order rolls back the reservation and the outbox row.
- **Concurrency** — two simultaneous dispatches of the last unit: exactly one succeeds, one gets
  `409`, stock lands at zero, never negative.
- **Gapless invoice numbering** under concurrent issuance.
- **Idempotency** — the same key replays the stored response and does not double-charge.
- **Soft delete and audit** — deleted rows vanish from reads; every mutation writes an audit entry.

### E2E — Playwright, real browser, full stack
Restricted to journeys where a break is unacceptable:

1. Login → MFA → dashboard loads.
2. Onboard a distributor from lead to active with KYC verification.
3. Create a product with media, specs, and price list entry.
4. Quotation → order → approve → reserve → dispatch → invoice → payment → paid.
5. Stock adjustment with approval, reflected in balances.
6. Run a report and download the XLSX.
7. Permission boundary: a Sales Executive cannot see the approve button *and* the direct API call
   is rejected.
8. Accessibility: `axe` scan on every major page, zero critical violations.

E2E tests are expensive and flaky when overused. Forty well-chosen specs that always pass are worth
far more than four hundred that are routinely ignored.

---

## 3. Test data

`packages/testing` provides typed factories with sensible defaults and deep overrides:

```ts
const distributor = await factories.distributor.create({
  status: 'ACTIVE', creditLimit: money('500000'), territory: west,
});
const order = await factories.order.create({
  distributor, lines: [{ product: rakshaGateway, quantity: 10 }],
});
```

Deterministic seeds (fixed faker seed) so a failure reproduces exactly. No test depends on data
created by another test.

---

## 4. Coverage targets

| Layer | Target | Rationale |
|---|---|---|
| Domain / calculators | **95%** | Pure logic, cheap to cover, catastrophic when wrong |
| Services | **85%** | The business rules |
| Repositories | 70% | Covered mostly through integration tests |
| Controllers | 60% | Thin; covered through integration tests |
| Frontend components | 70% | Focused on `DataTable`, forms, permission gating |
| **Overall gate** | **80%** | CI fails below this |

Coverage is a floor, not a goal. A module at 85% with no concurrency test is worse than one at 70%
with one. Reviews check *what* is tested, not only how much.

---

## 5. CI pipeline

```yaml
on: [push, pull_request]
jobs:
  verify:
    - pnpm install --frozen-lockfile
    - pnpm lint                    # eslint + prettier check
    - pnpm typecheck               # tsc --noEmit across the workspace
    - pnpm test:unit               # fast, no containers
    - pnpm test:integration        # postgres + redis service containers
    - pnpm build                   # turbo build, all apps
    - pnpm openapi:check           # committed spec must match generated
    - pnpm audit --audit-level high
    - gitleaks detect
  e2e:
    needs: verify
    - docker compose -f infra/compose/docker-compose.test.yml up -d
    - pnpm test:e2e
    - upload traces on failure
```

`pnpm verify` runs the same sequence locally, so "green locally, red in CI" is not a normal
occurrence. A pre-push hook (husky) runs lint, typecheck, and unit tests.

Migration safety is its own check: CI applies migrations to a copy of the previous release's schema
to catch a migration that fails on existing data rather than on an empty database.

---

## 6. What we deliberately do not test

Named so the gaps are chosen rather than accidental: third-party SDK internals (Prisma, Nest), the
visual appearance of emails (a rendering preview is reviewed manually), exhaustive component
snapshots (brittle, low value), and live Google Sheets / SMTP calls (mocked at the transport
interface, with one manual smoke test per release).
