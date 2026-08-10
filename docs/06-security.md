# 06 — Security Design

> Phase 0 deliverable. Status: **Awaiting approval**

---

## 1. Threat model (what we are actually defending against)

| # | Threat | Realistic scenario | Primary control |
|---|---|---|---|
| T1 | Credential stuffing | Reused distributor-contact password from a breach | Argon2id, per-account lockout, per-IP+email rate limit, MFA-ready |
| T2 | Session hijacking via XSS | Malicious payload in a product description | Tokens never in JS-readable storage; strict CSP; React auto-escaping; sanitised rich text |
| T3 | Horizontal privilege escalation | Sales Exec for West edits a Central distributor by guessing an ID | Scope predicate injected at the repository layer; `404` not `403` |
| T4 | Vertical privilege escalation | Accounts Executive self-verifies a payment | Segregation of duties enforced in permission seeds + service rules |
| T5 | Financial tampering | Editing an issued invoice to reduce tax | Issued invoices immutable; corrections only via credit note; full audit trail |
| T6 | Malicious file upload | Web shell disguised as a PDF brochure | Magic-byte validation, extension allow-list, size cap, virus-scan hook, non-executable storage, never served from the app root |
| T7 | SQL injection | Crafted filter or sort parameter | Prisma parameterisation; filter/sort fields are allow-listed, never interpolated |
| T8 | CSRF | Authenticated admin visits a hostile page | `SameSite=Lax` cookies + double-submit CSRF token on all state changes |
| T9 | Data exfiltration | Compromised account exports the entire distributor list | Export requires a distinct permission, is rate-limited, and is audited with row counts |
| T10 | Insider misuse | Employee quietly changes a credit limit | Immutable audit log with before/after; auditor role; alert on sensitive-field changes |
| T11 | Secret leakage | `.env` committed, or secrets in logs | `.gitignore` + secret scanning in CI; Pino redaction; config validated at boot |
| T12 | Dependency compromise | Malicious transitive package | Lockfile committed, `pnpm audit` in CI, Dependabot, pinned base images |
| T13 | DoS via expensive queries | `?includeTotal=true` on 10M rows, or deep offset | Query cost guards, deep-offset rejection, statement timeout, per-user throttling |
| T14 | Backup exposure | Google Sheet shared publicly | Service-account access only, restricted-scope sheet, no public link, encrypted DB dumps |

---

## 2. OWASP Top 10 (2021) coverage

| Risk | Controls |
|---|---|
| **A01 Broken Access Control** | Four-layer enforcement (§4 of `04-rbac`), repository-level scoping via Prisma extension, no IDOR-able endpoints, `404` on out-of-scope, deny-by-default guards on every route |
| **A02 Cryptographic Failures** | Argon2id (m=64MB, t=3, p=4) for passwords; SHA-256 for refresh tokens; AES-256-GCM for bank details and MFA secrets at rest; TLS 1.2+ with HSTS preload; secrets never logged |
| **A03 Injection** | Prisma parameterised queries throughout; Zod validation on all inputs; output encoding by React. **No user input reaches raw SQL.** Audited in Phase 11.1 — the four raw call sites are: the outbox claim and reconciliation (tagged templates, parameterised); `SET statement_timeout` (wrapped in `Number()`, so a bad env value becomes `NaN` not SQL); `buildCountQuery` (identifiers from `pg_tables`, escaped anyway); and the backup harness (`$1::uuid[]` bind parameters) |
| **A04 Insecure Design** | This document set; threat model above; segregation of duties; ledgers over mutable counters; immutable financial documents; idempotency on money-moving endpoints |
| **A05 Security Misconfiguration** | Helmet with explicit CSP; Swagger disabled in production; stack traces never returned; config Zod-validated at boot so a misconfigured deploy fails immediately and loudly; containers run as non-root |
| **A06 Vulnerable Components** | `pnpm audit` gate in CI, Dependabot, pinned digests for base images, minimal Alpine images |
| **A07 Auth Failures** | Account lockout with exponential backoff, generic auth error messages, refresh rotation with reuse detection, session invalidation on password reset, MFA architecture in place |
| **A08 Data Integrity Failures** | Committed lockfile, signed container images (v2), no dynamic `eval`, file checksums, immutable audit log |
| **A09 Logging & Monitoring Failures** | Structured logs with request correlation, audit log of every mutation, security events alerted to the ops channel, failed-login and permission-denial monitoring |
| **A10 SSRF** | No user-supplied URLs are fetched. Google Sheets and SMTP endpoints come from validated config only |

---

## 3. Authentication specifics

```
Password policy   min 12 chars, zxcvbn score ≥ 3, checked against a common-password list.
                  No forced rotation (NIST 800-63B), no composition rules that push users to Pa$$w0rd1.
Hashing           argon2id, memoryCost 65536, timeCost 3, parallelism 4, unique salt.
Lockout           5 failures → 15 min lock; escalating to 1 h. Counter resets on success.
Enumeration       /login and /forgot-password return identical responses and timing for
                  existent and non-existent accounts — INCLUDING once an account is
                  locked. A locked account answers exactly as a wrong password does.
                  Phase 11.1 found this broken past the lockout threshold: six wrong
                  passwords flipped a real account to ACCOUNT_LOCKED while an absent
                  one stayed INVALID_CREDENTIALS, enumerating the user table six
                  requests at a time. The real owner is told by EMAIL instead
                  (SECURITY_ACCOUNT_LOCKED → the account-locked template), and the
                  audit log records reason: LOCKED for operators.
                  Pinned by login-enumeration.spec.ts.
Reset tokens      256-bit random, SHA-256 stored, single-use, 30 min TTL,
                  and using one revokes every active session.
MFA               TOTP (RFC 6238), encrypted secret, hashed single-use backup codes.
```

---

## 4. File upload pipeline

```
1. Extension allow-list       pdf jpg jpeg png webp xlsx csv docx dwg step
2. MIME + magic-byte check    Content-Type is a hint; file signature is the check
3. Size cap                   10 MB default, 50 MB for technical drawings (per-type config)
4. Filename                   Discarded. Stored under a generated UUID key; original kept as metadata
5. Checksum                   SHA-256 recorded for integrity and deduplication
6. Virus scan hook            VirusScanner interface; NoOp driver in dev, ClamAV in prod.
                              scanStatus = PENDING until clear; PENDING files cannot be downloaded
7. Storage                    Outside the web root, no execute permission, never directly served
8. Download                   Streamed through an authorized endpoint that re-checks permission
                              and scope. Content-Disposition: attachment. No public URLs
```

The virus-scan hook is a real interface with a real state machine — not a comment saying "add
scanning later". A file sits at `PENDING` and is undownloadable until a scanner clears it, so
enabling ClamAV in production is configuration, not a code change.

---

## 5. Rate limiting

| Scope | Limit |
|---|---|
| Nginx, per IP, global | 100 req/s burst 200 |
| `POST /auth/login` | 5 per 15 min per IP+email |
| `POST /auth/forgot-password` | 3 per hour per IP |
| Authenticated API, per user | 300 req/min |
| Exports and reports | 10 per hour per user |
| File uploads | 30 per hour per user |

Limits live in Redis so they hold across API replicas.

---

## 6. Headers

```nginx
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
Content-Security-Policy: default-src 'self';
  script-src 'self' 'nonce-{random}';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  font-src 'self';
  connect-src 'self';
  frame-ancestors 'none';
  object-src 'none';
  base-uri 'self';
  form-action 'self'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=()
```

Next.js is configured with a nonce-based CSP so `'unsafe-inline'` is not needed for scripts — the
single most valuable line in the policy.

---

## 7. Data protection

| Data | Treatment |
|---|---|
| Passwords | Argon2id, never recoverable |
| Refresh tokens | SHA-256 hashed |
| Bank account numbers | AES-256-GCM encrypted at rest, masked in the UI (`••••4471`), full value requires `distributor:update` |
| MFA secrets | AES-256-GCM encrypted |
| GSTIN / PAN | Stored plain (they are quasi-public business identifiers) but redacted from logs |
| Backups | `pg_dump` encrypted with `age` before leaving the host |
| Logs | Pino redaction of `password`, `token`, `authorization`, `cookie`, `secret`, `bankAccountNumber`, `otp` |

Encryption keys come from environment variables and are versioned (`ENCRYPTION_KEY_V1`) so key
rotation is possible without a flag day.

---

## 8. Audit logging

Captured for every mutation: actor (user, system, or API key), action, entity type and ID,
before/after JSON, IP, user agent, request ID, timestamp.

- **Append-only.** No update or delete path exists in code, and the application database role is
  granted only `INSERT` and `SELECT` on `audit_log`.
- **Sensitive-field alerts.** Changes to credit limits, roles, permissions, GSTIN, bank details, or
  system settings additionally raise a security event to the ops email channel.
- **Retained 24 months** in hot storage, then detached to cold storage after backup.

---

## 9. Secrets

Development uses a git-ignored `.env` seeded from a committed `.env.example` containing only
placeholders. Production secrets live in a root-owned `.env` file on the VPS with `600`
permissions, injected into containers by Compose. Secrets are never baked into images, never passed
as build args, and never printed by deployment scripts. CI runs `gitleaks` and fails on any hit.

---

## 10. What we are explicitly not doing in v1

Named so these are known gaps rather than assumed protections: no WAF beyond Nginx rate limiting;
no HSM/KMS (keys are env vars); no field-level encryption beyond the four items in §7; no anomaly
detection on user behaviour; no SOC 2 controls. Each is a reasonable v2 addition and none is
load-bearing for the threat model above.
