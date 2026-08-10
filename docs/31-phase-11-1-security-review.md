# 31 — Phase 11.1: security review, dependency audit, secret scan

> Reviewed against `docs/06-security.md`. Controls were tested by **execution against the running
> API** — a control is not verified until something is refused (HANDOFF §4.4).

---

## 1. Findings

| # | Severity | Finding | State |
|---|---|---|---|
| **F1** | **Moderate** | `/login` was an account-enumeration oracle past the lockout threshold | ✅ Fixed + pinned |
| **F2** | **Moderate** | `nodemailer` 6.10.1 — improper TLS certificate validation, on the invoice-sending path | ✅ Fixed (→ 9.0.5) |
| **F3** | Low | `buildCountQuery` interpolated identifiers unescaped | ✅ Hardened |
| **F4** | Doc | `docs/06-security.md` A03 claimed "zero raw SQL with interpolation" and cited a query ADR-0019 deleted | ✅ Corrected |
| **F5** | Info | 12 remaining advisories, all dev/build-only | ⬜ Triaged, carried |
| **F6** | **Blocking for prod** | Three secrets are still `CHANGE_ME_…` placeholders | ⬜ Owner action |

---

## 2. F1 — `/login` leaked which accounts exist

`docs/06-security.md` §3 promised:

> *"Enumeration — /login and /forgot-password return identical responses and timing for existent and
> non-existent accounts."*

It held for five attempts and broke on the sixth. Measured against the running API:

```
real account,     attempts 1-5 → INVALID_CREDENTIALS   attempt 6 → ACCOUNT_LOCKED
absent account,   attempts 1-7 → INVALID_CREDENTIALS   (never flips)
```

Six requests per candidate address therefore enumerated every valid account, and the
`ACCOUNT_LOCKED` message additionally disclosed the unlock timestamp. There was a **timing** tell
too: the locked branch returned before the argon2 verify, so a locked account answered measurably
faster — against the same sentence, which promises identical timing.

This is the recurring shape of every serious defect in this project: **the control worked in the
case everyone tested and failed in the one nobody did.**

### The fix

A locked account now answers exactly as a wrong password does, and burns the same time. The
defence is untouched — only the disclosure changed:

| | Before | After |
|---|---|---|
| Response to attacker | `ACCOUNT_LOCKED` + unlock time | `INVALID_CREDENTIALS` |
| Account actually locked | yes | **yes** — verified `locked_until` is still set |
| Owner told | in the HTTP response | **by email** — `SECURITY_ACCOUNT_LOCKED` → `account-locked`, already wired |
| Operator visibility | — | audit log records `reason: LOCKED` |

Re-measured after the fix: both sequences return `INVALID_CREDENTIALS` for all seven attempts, and
`locked_until` is still populated in the database.

Pinned by `login-enumeration.spec.ts`, which reads the source and fails the build if the disclosure
returns — the technique `invoice-immutability.spec.ts` established (§4.18). **The guard was proven
to bite**: reintroducing the original branch fails 2 of its 5 assertions.

---

## 3. F2 — nodemailer, the only advisory on a production path

`pnpm audit` reported **20 vulnerabilities: 1 critical, 8 high, 10 moderate, 1 low.** The count is
not the finding; the triage is.

`nodemailer` was the one that mattered: a **production dependency of the API**, on 6.10.1 (three
majors behind), sitting on the path that emails invoices to customers. Five advisories against it,
and the important one was not the HIGH:

> **moderate · Improper TLS Certificate Validation**

We connect to `smtp.hostinger.com:465` with `secure: true`. Broken certificate validation there
means a MITM reads invoices in flight and captures the SMTP credentials. The HIGH (addressparser
DoS) is lower practical risk here, because recipient addresses are validated on write.

Upgraded to **9.0.5**, and verified rather than assumed — HANDOFF §4.17, the trap that already cost
this project a pdfmake rewrite:

- probed the installed package: `createTransport`, `sendMail`, `verify`, `close` all present on v9;
- exercised the real `SmtpTransport` against a dead host — `verify()` still returns `false` rather
  than throwing, which `MailModule`'s fallback and the boot diagnostics both depend on;
- confirmed Phase 10's attachment plumbing still maps onto v9's shape.

**Audit after: 12 vulnerabilities, zero mentioning nodemailer.**

---

## 4. F5 — what remains, and why it is acceptable

All 12 are dev or build tooling that never reaches a production runtime:

| Package | Path | Why it does not ship |
|---|---|---|
| `vitest` *(the critical)* | `apps/web > vitest` | Test runner |
| `vite`, `esbuild` | via vitest | Test runner |
| `postcss` | `next > postcss` | Build-time CSS |
| `sharp` | `next > sharp` | Next image optimisation — **the one to watch**; revisit at 11.4 |
| `nanoid` | `@nestjs/cli > fork-ts-checker` | Build tooling |
| `js-yaml` | `@nestjs/swagger` | Swagger is config-disabled in production |

**Honest caveat:** `sharp` is a genuine runtime dependency of Next's image optimisation. It is
carried rather than fixed because the fix is a Next upgrade, which belongs with 11.4 rather than
buried in a security pass. Recorded here so it is a decision, not an oversight.

---

## 5. Controls verified by execution

| Control | Method | Result |
|---|---|---|
| Login enumeration | 7 attempts, real vs absent account, byte-compared responses | ✅ identical (after F1) |
| Account lockout | 7 consecutive failures | ✅ locks at the 6th, `locked_until` set |
| Dev-account seed guard | `NODE_ENV=production` + a Proxy that throws on **any** database access | ✅ returned without touching the database |
| `.env` never committed | `git log --all --diff-filter=A` | ✅ never; gitignored |
| Secrets in tracked files | pattern scan across all tracked files | ✅ only placeholders (`docs/28` `MIIEv...`) |
| Raw SQL | audited all four call sites | ✅ no user input reaches SQL |

---

## 6. F6 — owner action, blocking production boot

`env.schema.ts` fails closed on all of these, deliberately. Currently placeholders or empty:

| Variable | State | Note |
|---|---|---|
| `JWT_SECRET` | `CHANGE_ME_…` | `openssl rand -base64 48` |
| `CSRF_SECRET` | `CHANGE_ME_…` | `openssl rand -base64 48` |
| `ENCRYPTION_KEY_V1` | `CHANGE_ME_…` | `openssl rand -base64 32` — ⚠️ set **before** any real bank details are entered; changing it later makes existing ciphertext undecryptable |
| `MAIL_OPS_*` | empty | Ops alerts recorded `UNDELIVERABLE`, not delivered (ADR-0022) |
| `MAIL_BUSINESS_PASSWORD` | empty | Invoices do not reach partners in production |
| `BACKUP_GPG_RECIPIENT` | empty | `docs/29` §2 |

---

## 7. Not done in 11.1

- **`/forgot-password` enumeration** was not measured. §3 makes the same promise for it; F1 shows
  that promise can be false in a branch nobody exercised. Worth the same seven-request treatment.
- **Timing enumeration was reasoned about, not measured.** `burnTime()` is now called on the locked
  path, but no statistical timing comparison was run. A real check needs many samples and a quiet
  machine.
- **Penetration testing.** This is a code and configuration review, not an adversarial test.
- **CI enforcement.** §A06 claims a `pnpm audit` gate in CI and Dependabot. Neither exists — there
  is no CI pipeline in this repo at all. That belongs with 11.4.
