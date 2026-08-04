# 15 — Phase 3: Master Data — Completion Record

> Status: **Complete and verified.** Ready for Phase 4 — Catalog & Pricing.

---

## 1. Gate results

| # | Gate | Result |
|---|---|---|
| 1 | **Design** | Three latent bugs found and recorded in §3 |
| 2 | **Database** | Migration 0004: geography, territories, warehouses, industries |
| 3 | **API** | Territories, geography lookups, settings, documents |
| 4 | **Backend** | Materialised-path tree, scope activation, typed settings, magic-byte file validation |
| 5 | **Frontend** | Territory tree, settings screen, navigation updated |
| 6 | **Tests** | 92 passing (65 contracts · 77 API) |
| 7 | **Documentation** | This record |
| 8 | **Verification** | `pnpm verify` green; verified in-browser as both a global and a scoped user |

Seeded: 1 country · 38 states/UTs with GST codes · 14 cities · 5 industries · 18 territories.

---

## 2. What exists

**Geography** — Country/State/City/Address. The state list derives from the same
`GST_STATE_CODES` constant the GSTIN validator checks against, so the database cannot accept
a code the validator rejects. Industries promoted from a settings JSON blob to real rows,
ready for Customer to reference by FK in Phase 7.

**Territories** — Materialised-path tree with leading and trailing separators (so a scope
check cannot prefix-match an unrelated subtree), cycle-protected subtree moves in a single
transaction, manager assignment, flat and nested endpoints.

**Settings** — Typed service over `SystemSetting` with per-key Zod validation, Redis caching,
secret redaction, and a `writable` flag distinguishing operator-editable configuration from
seeded reference content. Every change is audited as a SECURITY event.

**Documents** — Finally uses the `StorageService` and `VirusScanner` built in Phase 1.
Validation by magic bytes, checksum deduplication, scan before the bytes reach disk, storage
under a generated key, and streamed download with permission re-checked per request.

---

## 3. Three latent bugs, all exposed by activating scope

Until a scoped model existed, neither extension had anything to act on, so none of these was
observable. Registering `territory` is what made them surface.

### 3.1 Both Prisma extensions were silent no-ops (critical)

Prisma passes client extensions a **PascalCase** model name (`"Territory"`); both registries
were keyed camelCase. Every lookup missed.

From Phase 1 onward this meant **no scope predicate was ever injected** — the mechanism
ADR-0003 is built on did nothing — and **soft delete never applied**, so `delete()` was a
hard delete and reads included soft-deleted rows. Nothing failed loudly.

Fixed with a single `modelKey()` helper at every registry boundary, plus regression tests
that assert against `Prisma.dmmf` model names rather than literals, so the test cannot drift
from what Prisma actually passes.

### 3.2 Request context was established after the guards that populate it (critical)

Nest runs **middleware → guards → interceptors → pipes → handler**. The request context lived
in an interceptor, so `JwtAuthGuard` wrote the caller into a context that did not exist yet.
The comment in that file asserted the opposite ordering.

Hidden by §3.1. Fixing the casing made scope correctly deny *everything*, which is what
surfaced this. Moved to `RequestContextMiddleware`.

### 3.3 Soft delete could not work from a query hook

It called `Prisma.getExtensionContext(this).update()` inside a `query` extension — a technique
that only works in `model` extensions — so every delete failed with
`context.update is not a function` once the extension started firing.

A query hook cannot rewrite one operation into another. The contract is now explicit: hard
`delete` on a soft-deletable model **throws** naming the method to use, and `softDelete()`,
`softDeleteMany()`, and `restore()` are model methods. Accidental hard-delete is impossible,
and so is a silent no-op.

---

## 4. Verified against a running system

| Claim | Result |
|---|---|
| Territory tree | 5 zones, 18 nodes, correct depths and GST codes |
| GLOBAL admin | Sees 18 of 18 |
| **Territory-scoped user** | WEST manager sees exactly 4 — the zone plus its 3 states — from one assignment |
| Subtree expansion | 1 role assignment resolved to 4 territory ids |
| **Out-of-scope access by id** | `404`, not `403` — no enumeration oracle |
| Soft delete | Row retained with `deleted_at` set; hidden from API; list count restored |
| Settings validation | A bad GSTIN check digit rejected with a field-level message |
| Settings immutability | Seeded portfolio content refused with an explanation |
| Settings audit | Recorded as a SECURITY event with the setting key |
| **Disguised file** | Shell script renamed `.pdf` rejected on magic bytes |
| SVG upload | Refused outright — XML that browsers execute |
| Deduplication | Identical re-upload returned the same document; one row |
| Download | `attachment` + `nosniff` + `no-store`; `401` unauthenticated |
| Storage permissions | `0640`, outside any served directory |
| **In-browser** | WEST manager sees 4 territories, and the entire System nav section is absent |

That last row shows both halves of the authorization model working together: permission
gating hides the navigation, and row scoping bounds the data — independently enforced.

---

## 5. Known state

| Item | Status |
|---|---|
| Territory create/edit UI | Read-only tree. The API is complete; forms follow the Phase 4 catalog work |
| Settings editing UI | Read-only with a `writable` flag. `PUT` is built and tested; per-category forms follow |
| Statutory details | `verified: false`, surfaced as a banner. Invoicing must check this before issuing (question E1) |
| ClamAV | Interface and state machine live; driver throws at boot rather than silently degrading |
| Warehouses | Model and relations exist; CRUD arrives with inventory in Phase 6 |

---

## 6. The lesson worth carrying forward

Both critical bugs survived two completion reviews. A green build, passing tests, and a
working login coexisted for two phases with an authorization mechanism doing nothing at all.

The only thing that found them was making something depend on them and then checking that a
request was **denied**.

Phase 5 makes distributors the second scoped entity. The same trap is available, and the same
rule applies: **a security control is not verified until something is refused.**
