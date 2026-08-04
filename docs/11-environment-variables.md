# 11 — Environment Variables

> Phase 0 deliverable. Status: **Awaiting approval**

Every variable below is validated by a **Zod schema at application boot**. A missing, empty, or
malformed value crashes the process immediately with a readable message naming the variable. It
never surfaces as a mysterious `undefined` inside a request three days later.

Secrets marked 🔐 must never be committed. `.env.example` contains placeholder values only.

---

## Core

| Variable | Example | Notes |
|---|---|---|
| `NODE_ENV` | `production` | `development` \| `test` \| `production` |
| `APP_NAME` | `Hixaa DMS` | |
| `APP_URL` | `https://dms.hixaa.com` | Public web URL; used in email links |
| `API_URL` | `https://dms.hixaa.com/api` | Public API base |
| `API_PORT` | `4000` | |
| `WEB_PORT` | `3000` | |
| `TZ` | `Asia/Kolkata` | Presentation timezone; storage is always UTC |
| `LOG_LEVEL` | `info` | `trace`…`fatal` |

## Database

| Variable | Example | Notes |
|---|---|---|
| `DATABASE_URL` 🔐 | `postgresql://hixaa:pw@postgres:5432/hixaa_dms?schema=public&connection_limit=20` | |
| `DATABASE_READ_URL` 🔐 | *(optional)* | Read replica; falls back to `DATABASE_URL` |
| `DATABASE_POOL_SIZE` | `20` | |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `30000` | Backstop against runaway queries |

## Redis & queues

| Variable | Example |
|---|---|
| `REDIS_URL` 🔐 | `redis://:password@redis:6379/0` |
| `REDIS_PASSWORD` 🔐 | |
| `QUEUE_PREFIX` | `hixaa` |
| `QUEUE_CONCURRENCY` | `5` |
| `WORKER_ENABLED` | `true` — `false` on API-only replicas |

## Authentication

| Variable | Example | Notes |
|---|---|---|
| `JWT_PRIVATE_KEY` 🔐 | *(PEM, base64)* | RS256 signing key |
| `JWT_PUBLIC_KEY` | *(PEM, base64)* | Verification key |
| `JWT_ACCESS_TTL` | `15m` | |
| `JWT_REFRESH_TTL` | `7d` | |
| `JWT_REFRESH_TTL_REMEMBER_ME` | `30d` | |
| `JWT_ISSUER` | `hixaa-dms` | |
| `SESSION_COOKIE_NAME` | `hixaa_rt` | |
| `SESSION_COOKIE_DOMAIN` | `.hixaa.com` | |
| `CSRF_SECRET` 🔐 | *(32 bytes)* | |
| `ENCRYPTION_KEY_V1` 🔐 | *(32 bytes, base64)* | AES-256-GCM for bank details & MFA secrets |
| `ENCRYPTION_KEY_ACTIVE` | `V1` | Enables key rotation without a flag day |
| `ARGON2_MEMORY_COST` | `65536` | |
| `ARGON2_TIME_COST` | `3` | |
| `PASSWORD_MIN_LENGTH` | `12` | |
| `LOGIN_MAX_ATTEMPTS` | `5` | |
| `LOGIN_LOCKOUT_MINUTES` | `15` | |
| `MFA_ISSUER` | `Hixaa DMS` | |

## ✉️ Business email — Hostinger (customer-facing only)

| Variable | Example |
|---|---|
| `MAIL_BUSINESS_DRIVER` | `smtp` |
| `MAIL_BUSINESS_HOST` | `smtp.hostinger.com` |
| `MAIL_BUSINESS_PORT` | `465` |
| `MAIL_BUSINESS_SECURE` | `true` |
| `MAIL_BUSINESS_USER` 🔐 | `noreply@hixaa.com` |
| `MAIL_BUSINESS_PASSWORD` 🔐 | |
| `MAIL_BUSINESS_FROM_NAME` | `Hixaa Technologies` |
| `MAIL_BUSINESS_FROM_ADDRESS` | `noreply@hixaa.com` |
| `MAIL_BUSINESS_REPLY_TO` | `info@hixaa.com` |

Used **only** for: welcome, email verification, password reset, order confirmation, dispatch notice,
invoice delivery, payment receipt, distributor notifications, scheduled reports, reminders.

## 🛠 Ops email — Gmail (developer/infrastructure only)

| Variable | Example |
|---|---|
| `MAIL_OPS_DRIVER` | `smtp` |
| `MAIL_OPS_HOST` | `smtp.gmail.com` |
| `MAIL_OPS_PORT` | `587` |
| `MAIL_OPS_SECURE` | `false` (STARTTLS) |
| `MAIL_OPS_USER` 🔐 | `your.address@gmail.com` |
| `MAIL_OPS_PASSWORD` 🔐 | *Google **App Password**, not the account password* |
| `MAIL_OPS_FROM_ADDRESS` | `your.address@gmail.com` |
| `MAIL_OPS_TO` | `siddhantbhutada725@gmail.com` |

Used **only** for: deployment results, migration outcomes, backup reports, error alerts, health-check
failures, queue/DLQ alerts, certificate expiry, security events.

> The two channels are separate transports behind a typed interface. Sending a business template on
> the ops channel — or the reverse — is a **TypeScript compile error**, not a runtime possibility.
> See `07-integrations.md` §1.

## Storage

| Variable | Example | Notes |
|---|---|---|
| `STORAGE_DRIVER` | `local` | `local` \| `s3` |
| `STORAGE_LOCAL_PATH` | `/var/hixaa/uploads` | |
| `STORAGE_SIGNED_URL_TTL` | `900` | Seconds |
| `S3_ENDPOINT` | `https://s3.ap-south-1.amazonaws.com` | Set when `STORAGE_DRIVER=s3` |
| `S3_REGION` · `S3_BUCKET` | `ap-south-1` · `hixaa-dms` | |
| `S3_ACCESS_KEY_ID` 🔐 · `S3_SECRET_ACCESS_KEY` 🔐 | | |
| `UPLOAD_MAX_SIZE_MB` | `10` | |
| `UPLOAD_MAX_SIZE_DRAWING_MB` | `50` | CAD/STEP files |
| `VIRUS_SCAN_DRIVER` | `noop` | `noop` \| `clamav` |
| `CLAMAV_HOST` · `CLAMAV_PORT` | `clamav` · `3310` | |

## Google Sheets backup

| Variable | Example | Notes |
|---|---|---|
| `SHEETS_ENABLED` | `true` | |
| `SHEETS_SERVICE_ACCOUNT_EMAIL` 🔐 | `hixaa-backup@…gserviceaccount.com` | |
| `SHEETS_PRIVATE_KEY` 🔐 | *(PEM, `\n` escaped)* | |
| `SHEETS_SPREADSHEET_ID_PRIMARY` | | Users, Distributors, Products |
| `SHEETS_SPREADSHEET_ID_TRANSACTIONS` | | Orders, Payments, Inventory (sharded — see `07` §2) |
| `SHEETS_SYNC_CRON` | `0 2 * * *` | 02:00 IST |
| `SHEETS_BATCH_SIZE` | `1000` | |
| `SHEETS_MAX_REQUESTS_PER_MINUTE` | `250` | Under Google's ~300 quota |

## Search, cache, rate limits

| Variable | Example |
|---|---|
| `SEARCH_DRIVER` | `postgres` (`meilisearch` later) |
| `CACHE_TTL_DEFAULT` · `CACHE_TTL_DASHBOARD` · `CACHE_TTL_REFERENCE` | `300` · `300` · `3600` |
| `THROTTLE_TTL` · `THROTTLE_LIMIT` | `60` · `300` |
| `THROTTLE_AUTH_LIMIT` | `5` |

## Business configuration

Seeded into `SYSTEM_SETTING` on first boot and **editable from the Admin Panel thereafter**. These
env vars are bootstrap values only — the database is the source of truth once seeded.

| Variable | Example |
|---|---|
| `COMPANY_LEGAL_NAME` | `Hixaa Technologies Pvt. Ltd.` |
| `COMPANY_GSTIN` | `27XXXXXXXXXXXZX` |
| `COMPANY_PAN` | `XXXXX0000X` |
| `COMPANY_STATE_CODE` | `27` (Maharashtra — drives CGST/SGST vs IGST) |
| `COMPANY_ADDRESS` | `Yogeshwar, Plot #26B, Anmol Nagar, Wathoda Square, Nagpur 440035` |
| `COMPANY_EMAIL` · `COMPANY_PHONE` | `info@hixaa.com` · `+91-9372429144` |
| `DEFAULT_CURRENCY` | `INR` |
| `FINANCIAL_YEAR_START_MONTH` | `4` (April) |
| `INVOICE_NUMBER_PREFIX` | `HTPL/INV` |
| `ORDER_NUMBER_PREFIX` | `SO` |

## Feature flags

| Variable | Default |
|---|---|
| `FEATURE_MFA_ENABLED` | `false` |
| `FEATURE_SECONDARY_SALES` | `true` |
| `FEATURE_EINVOICE` | `false` |
| `FEATURE_SHEETS_BACKUP` | `true` |
| `FEATURE_SWAGGER` | `false` in production |

## Bootstrap (first run only)

| Variable | Notes |
|---|---|
| `SEED_SUPER_ADMIN_EMAIL` 🔐 | Created once; ignored if the user exists |
| `SEED_SUPER_ADMIN_PASSWORD` 🔐 | **Forces a password change on first login** |

---

## Files

| File | Committed | Purpose |
|---|---|---|
| `.env.example` | ✅ | Placeholders + documentation. The contract |
| `.env` | ❌ | Local development |
| `.env.test` | ✅ | Deterministic CI values, no real secrets |
| `.env.production` | ❌ | On the VPS only, root-owned, `600` |
