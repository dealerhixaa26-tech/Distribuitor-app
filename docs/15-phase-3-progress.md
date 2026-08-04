# 15 — Phase 3: Master Data — Progress

> Status: **Partially complete.** Geography, territories, and scope activation are done and
> verified. Settings, documents, and the Phase 3 frontend remain.

---

## 1. What is complete

| Item | State |
|---|---|
| **Geography** | Country/State/City/Address models. All 38 Indian states and UTs seeded with GST codes, derived from the same `GST_STATE_CODES` constant the GSTIN validator uses |
| **Industries** | Promoted from a `SystemSetting` JSON blob to real rows, ready for Customer to reference by FK in Phase 7 |
| **Territories** | Materialised-path tree with cycle protection, subtree moves in one transaction, manager assignment, tree and flat endpoints |
| **Warehouses** | Model and relations (the stock ledger that gives them meaning arrives in Phase 6) |
| **Scope activation** | `SCOPE_REGISTRY` is live. Verified end to end — see §3 |
| **Tests** | 92 passing (65 contracts · 77 API), up from 119 total |

Seeded: 1 country · 38 states · 14 cities · 5 industries · 18 territories across 5 zones.

---

## 2. Two latent bugs found — both had been inert since Phase 1

Activating the scope registry is what exposed these. Until a scoped model existed, neither
extension had anything to act on, so neither failure was observable.

### 2.1 Both Prisma extensions were silent no-ops (critical)

Prisma passes client extensions a **PascalCase** model name (`"Territory"`). Both registries
were keyed camelCase (`territory`). Every lookup missed.

Consequences, from Phase 1 onward:
- **No scope predicate was ever injected.** The mechanism ADR-0003 is built on did nothing.
- **Soft delete never applied.** `delete()` was a hard delete, and reads included
  soft-deleted rows.

Neither failed loudly. The queries simply ran unguarded, and every test passed because no
test had yet asked a scoped question.

Fixed by normalising through a single `modelKey()` helper at every registry boundary, with
regression tests that assert against `Prisma.dmmf` model names rather than hand-written
strings — so the test cannot drift from what Prisma actually passes.

### 2.2 Request context was established after the guards that populate it (critical)

NestJS runs **middleware → guards → interceptors → pipes → handler**. The request context
lived in an interceptor, so `JwtAuthGuard` wrote `userId` and `access` to a context that did
not exist yet — a silent no-op — and the interceptor then created a fresh, empty one.

The comment in that file asserted the opposite ordering. It was wrong.

This was invisible while §2.1 masked it. The moment the scope extension started working, it
correctly denied *every* scoped read, because a request with no resolved caller must see
nothing. That over-denial is what surfaced the bug.

Moved to `RequestContextMiddleware` — the only layer that runs before guards.

### 2.3 A third, smaller one

Soft delete had been implemented by calling `Prisma.getExtensionContext(this).update()` from
inside a `query` hook. That works in `model` extensions, not `query` ones, so every delete
failed with `context.update is not a function` once the extension started firing.

Rewriting one operation into another is not something a query hook can do. So the contract
is now explicit: hard `delete` on a soft-deletable model **throws** with a message naming the
method to use, and `softDelete()` / `softDeleteMany()` / `restore()` are added as model
methods. A developer cannot accidentally hard-delete, and cannot silently get a no-op either.

---

## 3. Verified against a running system

| Claim | Result |
|---|---|
| Territory tree renders | 5 zones, 18 nodes, depths and GST codes correct |
| GLOBAL admin sees everything | 18 of 18 |
| **Territory-scoped user sees only their subtree** | WEST manager sees exactly 4 — `WEST` + its 3 states — from a single zone assignment |
| Subtree expansion works | 1 role assignment resolved to 4 territory ids |
| **Out-of-scope access by direct id** | `404 NOT_FOUND`, not 403 — no enumeration oracle |
| Soft delete preserves the row | `DELETE` → 204, row retained with `deleted_at` set |
| Soft-deleted rows are hidden | Detail returns 404; list count returns to 18 |
| Geography lookups | 38 states, Maharashtra correctly `27` |

That third row is ADR-0003 doing its job on real rows for the first time.

---

## 4. What remains in Phase 3

| Item | Notes |
|---|---|
| **Settings module** | Typed service over `SystemSetting` with Redis caching and secret redaction. The data is already seeded; the read/update API is not built |
| **Documents** | `StorageService` and `VirusScanner` were built in Phase 1 and are unused. Needs the upload endpoint, magic-byte validation, checksum dedup, entity linking, and streamed authorized download |
| **Frontend** | Territory tree UI, settings screen, document upload. The API is complete for territories and geography |

None of it is blocked — this is a natural checkpoint, not a wall.

---

## 5. Note on the two critical bugs

Both had existed since Phase 1 and survived two completion reviews, because the only honest
way to find them was to make something depend on them. A green build, passing tests, and a
working login all coexisted with an authorization mechanism that was doing nothing at all.

The lesson worth carrying into Phase 5, where distributors become the second scoped entity:
**a security control is not verified until something is denied.** The Phase 2 record claimed
scoped RBAC worked on the strength of permission checks passing; permissions were enforced,
but row scoping was not, and nothing distinguished the two until a territory-scoped user
asked for a territory they should not see.
