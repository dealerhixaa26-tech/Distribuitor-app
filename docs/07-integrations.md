# 07 — Integrations: Email, Google Sheets, Storage, Search

> Phase 0 deliverable. Status: **Awaiting approval**

---

## 1. Email — two channels that must never mix

You have two mailboxes with two entirely different audiences, and the system treats them as two
transports with **no shared code path beyond the interface**.

| | **BUSINESS** channel | **OPS** channel |
|---|---|---|
| Transport | Hostinger Business Email (SMTP) | Personal Gmail (SMTP / app password) |
| From | `noreply@hixaa.com`, `sales@hixaa.com` | `hixaa.ops@gmail.com` |
| Audience | Distributors, customers, employees | You, the developer/operator |
| Branding | Full Hixaa template, logo, footer, unsubscribe where applicable | Plain monospace, no branding |
| Used for | Welcome, verify email, password reset, order confirmation, dispatch notice, invoice, payment receipt, distributor notifications, scheduled reports, reminders | Deploy success/failure, migration results, backup reports, error spikes, health-check failures, queue depth alerts, certificate expiry, security events |

### Design

```ts
// infrastructure/mail/mail.service.ts
export enum MailChannel { BUSINESS = 'BUSINESS', OPS = 'OPS' }

export interface MailTransport {
  send(message: OutboundMail): Promise<{ messageId: string }>;
}

@Injectable()
export class MailService {
  constructor(
    @Inject('BUSINESS_TRANSPORT') private business: MailTransport,
    @Inject('OPS_TRANSPORT') private ops: MailTransport,
  ) {}

  // Callers pick a channel by *intent*; they never learn which SMTP host is behind it.
  async sendBusiness(template: BusinessTemplate, to: string, data: unknown) { … }
  async sendOps(template: OpsTemplate, subject: string, data: unknown) { … }
}
```

Three properties fall out of this design:

1. **Templates are typed per channel.** `BusinessTemplate` and `OpsTemplate` are disjoint unions.
   Sending a deployment notification to a distributor is a **compile error**, not a mistake caught
   in production. This is the strongest possible enforcement of your separation requirement.
2. **Adding a provider is adding a class.** `SmtpTransport` today; `SesTransport`,
   `ResendTransport`, or `PostmarkTransport` later implement the same interface. No business logic
   changes — a module calls `sendBusiness('order-confirmed', …)` and is unaffected.
3. **All sending is asynchronous** through the `email` BullMQ queue, fed by the outbox. A slow SMTP
   handshake never touches an API request.

```
Service ──tx──> OutboxEvent ──dispatcher──> BullMQ 'email' ──worker──> MailService ──> SMTP
                                                                            └──> EmailLog
```

Retries: 5 attempts, exponential backoff (1m, 5m, 15m, 1h, 6h), then dead-letter. Business-channel
failures raise an **ops** alert — so a broken customer mail path notifies you rather than failing
silently.

Templates are MJML compiled to responsive HTML at build time, with plain-text alternates. Local
development points both channels at **Mailpit**, so no real mail is ever sent from a dev machine.

---

## 2. Google Sheets backup

**Backup only. Never a source of truth, never in a request path.**

### Entities (as specified)
`Users` · `Products` · `Distributors` · `Orders` · `Payments` · `Inventory` — one worksheet each,
plus a `_meta` sheet recording last sync time, row counts, and schema version.

### Modes
| Mode | Trigger |
|---|---|
| **Scheduled** | BullMQ repeatable job, nightly 02:00 IST (configurable) |
| **Manual** | `POST /backup/sheets/sync` → `202` + job id |
| **Restore** | `POST /backup/sheets/restore` — **dry-run by default**, requires `backup:restore`, produces a diff report before anything is written |

### How it stays safe and fast

- **Runs only in the worker process.** The API never calls the Sheets API.
- **Chunked and checkpointed.** Rows stream in batches of 1 000 via keyset pagination, with
  `SyncJob.checkpointCursor` persisted after each batch. A failure at row 400 000 resumes from
  400 000 rather than restarting.
- **Quota-aware.** Google Sheets allows ~300 write requests/min/project. The job uses
  `values.batchUpdate`, a token-bucket limiter, and backs off on `429`/`503`.
- **Full replace per entity**, written to a temporary sheet then swapped, so a failed run never
  leaves a half-written backup that looks complete.
- **Sensitive fields are excluded or masked** — no password hashes, no refresh tokens, no decrypted
  bank numbers. A spreadsheet is a weaker security boundary than the database, and the backup is
  scoped accordingly.
- **Alerting.** Success writes a summary to `SyncJob`; failure and partial success page the **ops**
  channel. A backup that silently stops is worse than no backup, because it manufactures false
  confidence.

### Restore semantics
Restore is deliberately awkward. It is dry-run first, produces a row-level diff, requires an
explicit confirmation token, refuses to run against a non-empty table without `--force`, and writes
a full audit entry. Restores are rare, high-stakes, and should feel that way.

### Honest limitation
Google Sheets caps at 10 million cells per spreadsheet. At the stated scale (1M+ products), a single
spreadsheet will not hold everything. The design therefore **shards by entity across multiple
spreadsheets** with an index sheet, and — recorded in `12-recommendations.md` — Sheets is treated as
a *convenience* backup for human inspection, while nightly encrypted `pg_dump` is the *real*
disaster-recovery mechanism. Relying on Sheets alone for recovery of a million-row database would be
negligent, and I would rather say so now than discover it during an incident.

---

## 3. Storage

```ts
export interface StorageService {
  put(key: string, body: Buffer | Readable, meta: ObjectMeta): Promise<StoredObject>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
  exists(key: string): Promise<boolean>;
}
```

| Driver | When |
|---|---|
| `LocalStorageDriver` | Development and v1 production (VPS disk, `/var/hixaa/uploads`, mounted volume) |
| `S3StorageDriver` | Production when object storage is adopted — S3, Wasabi, Backblaze B2, or Hostinger object storage |

Keys are content-addressed by prefix (`documents/2026/08/{uuid}.pdf`) so migration to S3 is a copy
plus an env change: `STORAGE_DRIVER=s3`. No application code changes, because nothing outside the
driver knows where files live. `signedUrl` is implemented on the local driver too (a short-lived
HMAC token) so that call sites behave identically on both.

---

## 4. Search

```ts
export interface SearchProvider {
  index(entity: SearchableEntity, doc: SearchDocument): Promise<void>;
  search(query: SearchQuery): Promise<SearchResult>;
  reindex(entity: SearchableEntity): Promise<void>;
}
```

**v1: `PostgresSearchProvider`**
- Generated `tsvector` columns with weighted fields (`A` name/SKU, `B` code/tags, `C` description),
  GIN-indexed. Weighting means an exact SKU match outranks a description mention.
- `pg_trgm` similarity for typo tolerance ("raksah" → "Raksha").
- `unaccent` for diacritic-insensitive matching.
- Cross-entity global search (`⌘K`) unions per-entity queries with a scope filter applied to each.

**Later: `MeilisearchProvider`** — implements the same interface. The migration is a new class, a
reindex job, and an env flag. Nothing calling `SearchProvider` changes.

---

## 5. e-Invoice & e-Way Bill (adapter hooks, not integrations)

Per the confirmed scope, v1 ships the interfaces and the database columns but no live GSP calls:

```ts
export interface EInvoiceProvider {
  generateIrn(invoice: Invoice): Promise<{ irn: string; ackNo: string; qrCode: string }>;
  cancelIrn(irn: string, reason: string): Promise<void>;
}
export interface EWayBillProvider {
  generate(shipment: Shipment): Promise<{ ewayBillNumber: string; validUntil: Date }>;
}
```

`NoopEInvoiceProvider` records intent and marks the invoice `irnStatus = NOT_APPLICABLE`. When you
obtain GSP credentials, a `NicEInvoiceProvider` is added and enabled by config. The invoice schema
already carries `irn`, `ackNumber`, `ackDate`, and `qrCodePayload`, so no migration is needed at
that point — which is exactly why they are in the v1 schema despite not being populated.

---

## 6. Notifications

```ts
export interface NotificationChannel {
  readonly key: 'IN_APP' | 'EMAIL' | 'SMS' | 'WHATSAPP';
  send(notification: Notification, recipient: Recipient): Promise<void>;
}
```

v1 ships `InAppChannel` (DB row + SSE push) and `EmailChannel` (business transport). `SmsChannel`
and `WhatsAppChannel` are new classes registered into the same dispatcher, honouring per-user
`NotificationPreference` rows that already have columns for them.

---

## 7. Integration failure policy

| Integration | If it fails | User impact |
|---|---|---|
| SMTP (business) | Retry with backoff → DLQ → **ops alert** | None on the request; the email arrives late |
| SMTP (ops) | Retry → log | None |
| Google Sheets | Retry → mark `SyncJob` FAILED → **ops alert** | **None whatsoever** |
| Storage | Fail the upload request with a clear `503` | Upload must be retried; nothing else affected |
| Redis | Cache misses fall through to Postgres; queues pause and resume | Slower, still correct |
| Postgres | Requests fail fast with `503`; healthcheck flips; Compose restarts | Genuine outage — this is the only hard dependency |

The recurring principle: **only Postgres is allowed to take the application down.** Everything else
degrades.
