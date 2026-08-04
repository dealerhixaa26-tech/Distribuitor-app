# 14 — Phase 2: Identity & Access — Completion Record

> Status: **Complete and verified.** Ready for Phase 3 — Master Data.

Measured against the eight-gate Definition of Done in `05-roadmap.md`.

---

## 1. Gate results

| # | Gate | Result |
|---|---|---|
| 1 | **Design** | ADR-0006 (Prisma deferral). One deviation and two bugs recorded in §3–4 |
| 2 | **Database** | Migration 0003 (timestamptz correction). Session, token, MFA, and audit tables now exercised |
| 3 | **API** | 24 endpoints across auth, users, roles, audit. OpenAPI decorated |
| 4 | **Backend** | Argon2id, refresh rotation with reuse detection, three global guards, scoped access resolution with Redis caching |
| 5 | **Frontend** | Login, route gate, permission-gated navigation, users list, roles, audit viewer, user menu |
| 6 | **Tests** | 119 passing (65 contracts · 54 API), up from 68 |
| 7 | **Documentation** | This record, ADR-0006, inline rationale throughout |
| 8 | **Verification** | `pnpm verify` green; full stack smoke-tested through the BFF |

---

## 2. What was verified against a running system

| Claim | How it was proven |
|---|---|
| Login works end to end | Through the browser UI and through the BFF; correct cookie flags on both |
| **Access token never reaches JavaScript** | Login response body inspected — `accessToken` absent; it lives only in an HTTP-only cookie |
| Refresh rotates | Old token replaced on every use; token value confirmed to change |
| **Reuse detection revokes the family** | Replayed a rotated token → `401 TOKEN_REUSE_DETECTED`, **and the current token died with it**, and the alert persisted |
| Deny-by-default | Unauthenticated request to any non-`@Public()` route → `401` |
| Permission enforcement | A `SUPPORT_AGENT` (12 permissions) got `403` on users, roles, and audit-logs, `200` on `/auth/me` |
| Segregation of duties | Creating a role with `payment:create` + `payment:verify` → `422` naming the conflict; same role without the pair succeeded |
| System roles immutable | `PATCH` on `AUDITOR` → `409` explaining that seeds reconcile on deploy |
| No email enumeration | `forgot-password` returns `204` identically for a real and a fake address |
| Invitation flow | Invite → outbox event → accept with self-chosen password → active session |
| Audit trail | Every login, failure, role change, and reset recorded with actor, IP, and request id |
| Append-only still enforced | `DELETE` on `audit_log` rejected by the trigger after a deliberate one-off correction |

---

## 3. Two bugs found and fixed

### 3.1 Reuse detection revoked nothing (security)

The obvious implementation put the reuse check, the family revocation, the security
alert, and the `throw` inside one transaction. **Throwing rolled the transaction back**,
undoing the revocation and discarding the alert. The endpoint correctly reported
`TOKEN_REUSE_DETECTED` while leaving the stolen token fully usable, and no alert was
ever sent.

This passed every surface-level check — the right status code, the right error message.
It was only caught by asking the follow-up question: *after detection, is the other token
actually dead?* It was not.

Fixed by committing the revocation in its own transaction and throwing afterwards. The
rotation path additionally now claims the old session with a conditional `updateMany`, so
two concurrent refreshes cannot both succeed; the loser is treated as reuse, because an
ambiguous signal should be read the hostile way.

### 3.2 Sixty columns were `timestamp` without a timezone

`docs/02-data-model.md` §0 states every timestamp is `TIMESTAMPTZ` in UTC. It was not:
Prisma's `DateTime` maps to a naive `timestamp(3)` unless given `@db.Timestamptz`.

Consequences:
- Any tool connecting with a non-UTC session (psql, a restore, a DBA) wrote wall-clock
  time and silently corrupted ordering — visible in the audit viewer as an entry dated
  *"in 34 minutes"*.
- The outbox dispatcher compares `available_at <= now()` in raw SQL. With naive columns
  and an `Asia/Kolkata` session, that compared a UTC value against an IST clock — **retries
  fired 5h30m early**.

Migration 0003 converts all 60 columns. It opens with `SET LOCAL TIME ZONE 'UTC'`, which is
load-bearing: a bare `SET DATA TYPE TIMESTAMPTZ` interprets existing naive values in the
session timezone and would have shifted every historical timestamp by −5h30m. Verified by
checking a known value before and after — `01:30:13.113` unchanged.

---

## 4. Deviation from the design

**`@typescript-eslint/consistent-type-imports` stays off for the API**, recorded in
`packages/config/eslint/nest.js`. Its autofix rewrites NestJS constructor dependencies to
type-only imports, which `emitDecoratorMetadata` erases — turning every injected
dependency into `UnknownDependenciesException` at boot. Found in Phase 1 by starting the
process rather than trusting a green build.

---

## 5. What exists now

```
24  endpoints            119  passing tests        3  migrations
 3  global guards        110  permissions         11  roles
```

**Authentication** — Argon2id with configurable cost and transparent rehash on login;
timing-equalised failure for unknown accounts (a real decoy hash, generated at boot);
account lockout with escalation; refresh rotation with family-wide reuse detection;
Remember Me; password reset that revokes every session; email verification; invitations
where the invitee chooses their own password so no temporary credential ever exists.

**Authorization** — three global guards (authenticate → CSRF → permission), deny-by-default;
effective access resolved as the union of role assignments and cached in Redis; the
permission-set fingerprint embedded in each access token so a revoked permission stops
working within the token TTL rather than at expiry; segregation-of-duties validation on
role creation; last-super-admin protection.

**Frontend** — login with the same Zod schema the API validates against; a BFF that keeps
the access token out of JavaScript and transparently refreshes on 401; middleware route
gate; permission-gated navigation that now populates; users, roles, and audit screens on
the shared `DataTable`.

---

## 6. Known state

| Item | Status |
|---|---|
| MFA | Schema, config, and contracts exist. Login **fails closed** when a user has `mfaEnabled` — enabling the flag cannot accidentally admit someone without a challenge. TOTP itself is not built |
| Teams | Schema exists; CRUD deferred — nothing depends on it until territories arrive in Phase 3 |
| Invite/edit user UI | The API is complete and tested; the list screen is read-only. Forms land alongside the Phase 3 settings work |
| `hixaa_dms` database | The pre-existing dev remnant is still untouched. This build uses `hixaa_dms_dev` |
| Repository | **Still not under version control.** Worth fixing before Phase 3 — see §7 |

---

## 7. One thing worth doing before Phase 3

There is **no git repository**. Nine thousand lines of source, three migrations, and two
phases of decisions exist only as files on disk. Everything CI expects — branches, the
`gitleaks` history scan, `deploy.sh` reading a previous tag for rollback — assumes git.

I have not run `git init` because initialising and committing is a decision about your
history and remote, not mine to make silently. Say the word and it is a one-minute job.

---

## 8. Next

**Phase 3 — Master Data**: geography with GST state codes, the territory hierarchy with
materialised paths, system settings backed by the seeded Hixaa profile, and the document
subsystem with upload validation and the virus-scan state machine.

Phase 3 is also where the scope machinery from ADR-0003 gets its first real workout:
territories are the first scoped entity, so `SCOPE_REGISTRY` stops being empty and the
Prisma extension starts filtering actual rows.
