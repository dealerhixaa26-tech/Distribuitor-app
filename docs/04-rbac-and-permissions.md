# 04 — Roles, Permissions & Data Scoping

> Phase 0 deliverable. Status: **Awaiting approval**

---

## 1. The model

Authorization answers two independent questions, and conflating them is the most common security
flaw in ERP systems:

| Question | Mechanism |
|---|---|
| **"May this user perform this action?"** | **Permission** — `order:approve` |
| **"On which records?"** | **Scope** — `GLOBAL` \| `TERRITORY:<id>` \| `DISTRIBUTOR:<id>` |

A Sales Manager for the West zone holds `order:approve` *scoped to* `TERRITORY:west`. The permission
check and the scope check are separate guards, and **both must pass**.

```
User ──< UserRole >── Role ──< RolePermission >── Permission
            │
            └── scopeType + scopeId   ← the data boundary
```

A user may hold several role assignments. Effective permissions are the **union** of permission
sets; effective scope is the **union** of scopes. Someone can be a Sales Manager for West *and* a
Sales Executive for Central without any special-casing.

---

## 2. Permission catalogue

Format: `resource:action`, optionally `resource:sub-resource:action`. Seeded as data, never hardcoded.

| Resource | Actions |
|---|---|
| `user` | `read` `create` `update` `delete` `suspend` `impersonate` |
| `role` | `read` `create` `update` `delete` `assign` |
| `team` | `read` `create` `update` `delete` |
| `distributor` | `read` `create` `update` `delete` `approve` `import` `export` `document:manage` |
| `territory` | `read` `create` `update` `delete` |
| `customer` | `read` `create` `update` `delete` |
| `product` | `read` `create` `update` `delete` `import` `export` `media:manage` |
| `category` `brand` `uom` | `read` `create` `update` `delete` |
| `pricelist` | `read` `create` `update` `delete` `publish` |
| `discount` | `read` `create` `update` `delete` `approve` |
| `inventory` | `read` `receive` `issue` `adjust` `transfer` `count` |
| `warehouse` | `read` `create` `update` `delete` |
| `quotation` | `read` `create` `update` `delete` `send` `convert` |
| `order` | `read` `create` `update` `delete` `submit` `approve` `reject` `cancel` `dispatch` |
| `invoice` | `read` `create` `issue` `cancel` `credit-note` `send` `export` |
| `payment` | `read` `create` `update` `verify` `delete` `allocate` |
| `report` | `read` `create` `run` `schedule` `export` |
| `analytics` | `read` `read:financial` |
| `document` | `read` `upload` `delete` |
| `setting` | `read` `update` |
| `auditlog` | `read` `export` |
| `backup` | `read` `run` `restore` |
| `notification` | `read` `send` |

`analytics:read` and `analytics:read:financial` are deliberately split: a Sales Executive should see
unit volumes and their own pipeline without seeing company-wide margin and revenue.

---

## 3. Role definitions (seeded, `isSystem = true`)

| Role | Scope | Permissions | Notes |
|---|---|---|---|
| **SUPER_ADMIN** | GLOBAL | All, including `setting:update`, `backup:restore`, `user:impersonate` | Bootstrap account. At least two must exist; the system refuses to remove the last one |
| **ADMIN** | GLOBAL | All except `backup:restore`, `user:impersonate`, and role editing | Day-to-day administration |
| **SALES_MANAGER** | TERRITORY | Distributor CRUD + `approve`; order `approve`/`reject`; quotation full; `discount:approve`; customer full; `analytics:read`; product/pricelist read | Territory owner |
| **SALES_EXECUTIVE** | TERRITORY | Distributor `read`/`create`/`update`; order `create`/`submit`; quotation full; customer full; product read; `analytics:read` | **Cannot approve their own orders** |
| **INVENTORY_MANAGER** | GLOBAL | Full `inventory`, `warehouse`, `order:dispatch`; product read/update | Warehouse operations |
| **FINANCE_MANAGER** | GLOBAL | Full `invoice`, `payment`, `analytics:read:financial`, `report:*`; distributor read + credit-limit update | Owns the money |
| **ACCOUNTS_EXECUTIVE** | GLOBAL | `payment:create`/`read`/`allocate`; `invoice:read`/`create` | **No `payment:verify`, no `invoice:issue`** |
| **SUPPORT_AGENT** | GLOBAL | Read on distributor, order, invoice, product, customer; `notification:send` | Query resolution |
| **AUDITOR** | GLOBAL | `*:read` + `auditlog:read`/`export` | Strictly read-only. Cannot mutate anything |
| **DISTRIBUTOR_OWNER** *(v2)* | DISTRIBUTOR | Own orders `read`/`create`/`submit`; own invoices/payments/ledger read; product read; own inventory read; own customers full | Portal |
| **DISTRIBUTOR_STAFF** *(v2)* | DISTRIBUTOR | Own orders `read`/`create`; product read | Portal |

### Segregation of duties

Three separations are enforced structurally rather than by policy documents, because financial
controls that depend on people remembering them are not controls:

1. **`payment:create` ≠ `payment:verify`.** The person recording a receipt cannot confirm it.
2. **`order:create` ≠ `order:approve`.** Plus an application rule: a user cannot approve an order
   they created, *regardless of permissions*.
3. **`invoice:create` ≠ `invoice:issue`.** Only issuing consumes a statutory number.

Custom roles can be created by SUPER_ADMIN, but the system rejects a role that combines a
mutually-exclusive pair and explains why.

---

## 4. Enforcement — four independent layers

```
1. Route guard      @RequirePermission('order:approve')   → 403 if absent
2. Scope guard      Resolves the caller's scope predicate  → 404 if out of scope
3. Repository       Scope predicate injected into every WHERE (Prisma extension)
4. Service rule     Business invariants (self-approval, credit limit, approval ceiling)
```

Layer 3 is the important one. Consider:

```ts
// The scope predicate the extension injects for a TERRITORY-scoped user
{ territoryId: { in: ['0192-west', '0192-central'] } }

// For a DISTRIBUTOR-scoped user (v2 portal)
{ distributorId: '0192-vidarbha' }

// For GLOBAL
{}   // no additional predicate
```

Because this is applied by a Prisma client extension keyed on the model's registered scope
strategy, **a developer cannot forget to filter**. Writing `prisma.order.findMany({})` in a new
endpoint returns only in-scope orders. Bypassing requires `withoutScope()`, which is explicit,
greppable, and flagged in code review.

Controller-level `@RequirePermission` on its own would be insufficient: it protects endpoints, not
rows. Both are required.

### Approval ceilings

Beyond permissions, monetary authority is a numeric limit on the role assignment:

| Role | Discount ceiling | Order value ceiling |
|---|---|---|
| Sales Executive | 0% | — (must submit for approval) |
| Sales Manager | up to 10% | up to ₹25,00,000 |
| Finance Manager | up to 20% | unlimited |
| Admin / Super Admin | unlimited | unlimited |

Exceeding a ceiling escalates to the next level rather than failing, and both the request and the
approval are audited. Ceilings are configurable in `SYSTEM_SETTING`, not compiled in.

---

## 5. Frontend behaviour

```tsx
const canApprove = usePermission('order:approve');
{canApprove && <Button onClick={approve}>Approve order</Button>}
```

Effective permissions arrive once from `GET /auth/me` and are cached in TanStack Query. Navigation
items, table row actions, and form fields are all permission-aware.

**This is presentation, not security.** Every check is independently enforced server-side. The rule
we hold to: *if the button were visible, clicking it would still be rejected by the API.*

---

## 6. Session & token design

| Token | Lifetime | Storage | Notes |
|---|---|---|---|
| **Access** | 15 min | Memory (server-side in the Next.js BFF); never in `localStorage` | JWT, RS256, contains `sub`, `sessionId`, `permissions` hash, `scopes` |
| **Refresh** | 7 days (30 with *Remember Me*) | HTTP-only, `Secure`, `SameSite=Lax` cookie, path-scoped to `/api/v1/auth` | Opaque random 256-bit value; only its SHA-256 hash is stored |
| **CSRF** | Session | Readable cookie + `X-CSRF-Token` header | Double-submit, validated on every state-changing request |

### Refresh rotation with reuse detection

Every refresh issues a new token and revokes the old one, all within a `familyId` lineage. If a
**already-rotated** token is presented, that means it was stolen and replayed, so the entire family
is revoked immediately, all sessions for that user are terminated, and a security alert is written
to the audit log and emailed to the ops channel.

Permissions are carried in the access token as a **hash**, not a list. On each request the guard
compares the hash against the cached effective permission set; a mismatch forces a refresh. This
keeps tokens small and — critically — means a revoked permission takes effect within 15 minutes
rather than persisting until token expiry.

---

## 7. Building the Distributor Portal later

Because the scope mechanism exists from day one, adding the portal in v2 requires:

1. A new Next.js app at `apps/portal` — **no backend changes**.
2. Seeding the two `DISTRIBUTOR_*` roles — already defined above.
3. Linking a `DistributorContact` to a `User` via `portalUserId` — the column already exists.

`GET /api/v1/orders` called by a distributor user returns only their orders, because the scope
predicate is already applied at the repository layer for every caller. There is no separate
"portal API" to build, and no risk of the portal accidentally reusing an admin query path that
forgot to filter — because no query path can forget.

This is the entire justification for the up-front cost of scoped RBAC, and it is recorded as
ADR-0003.
