# 28 — Google Sheets backup: setup guide (question E7)

> The Sheets backup is built and working against the local adapter. This is what turns on the
> Google one. Nothing in the application changes — it is a service account, two spreadsheets, and
> four environment variables.
>
> ✅ **This has now been done and verified** (2026-08-05). The adapter worked on first contact —
> authentication, sheet creation, chunked append, staging swap, read-back and the restore diff all
> succeeded against the live API. The two things that *did* go wrong were configuration, and both
> are called out below: `SHEETS_ENABLED=True` (§5) and an unquoted private key (§5).

---

## 0. Do you actually need this?

Probably not urgently. **`pg_dump` (module 10.3) is the disaster-recovery mechanism; Sheets is a
convenience copy for human inspection.** `docs/07` §2 says so, ADR-0024 says so, and Sheets caps at
10 million cells per spreadsheet, so it cannot hold the stated scale anyway.

Turn this on when you want to *look at* the data in a spreadsheet. Do not turn it on believing it is
your recovery plan.

Meanwhile the local adapter is already writing real CSVs to `storage/sheets-backup/`, so you have a
working backup of the six entities today.

---

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/> and sign in with the Google account that should own
   this. **Use a company account, not a personal one** — a service account owned by a personal
   Gmail becomes a problem the day that person leaves.
2. Click the project dropdown → **New Project**.
3. Name it something unambiguous, e.g. `hixaa-dms-backup`. No organisation is required.
4. Create, then make sure it is the selected project before continuing.

## 2. Enable the Sheets API

1. **APIs & Services → Library**.
2. Search for **Google Sheets API**.
3. **Enable**.

You do not need the Drive API. The application never creates or lists spreadsheets — you create
them by hand in §4 and give it the ids.

## 3. Create the service account and its key

1. **APIs & Services → Credentials → Create Credentials → Service account**.
2. Name: `hixaa-dms-backup`. Description: "Writes nightly DMS backups to Sheets".
3. **Skip both optional steps** (project role, user access). It needs no project-level IAM role —
   access is granted per spreadsheet in §4, which is much narrower.
4. Open the new service account → **Keys → Add key → Create new key → JSON → Create**.
5. A `.json` file downloads. **This is a credential.** Treat it like a password: do not commit it,
   do not email it, do not put it in a shared drive.

From that JSON you need exactly two fields:

```json
{
  "client_email": "hixaa-dms-backup@hixaa-dms-backup.iam.gserviceaccount.com",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n"
}
```

## 4. Create the two spreadsheets and share them

The backup shards across two books because one cannot hold everything (§0).

1. Create a spreadsheet named **Hixaa DMS — Masters**. It will hold `Users`, `Products`,
   `Distributors`.
2. Create another named **Hixaa DMS — Transactions**. It will hold `Orders`, `Payments`,
   `Inventory`.
3. In **each**, click **Share**, paste the service account's `client_email`, set **Editor**, and
   untick "Notify people". Share.
4. Take each spreadsheet's id from its URL:

```
https://docs.google.com/spreadsheets/d/1AbC...XyZ/edit
                                      ^^^^^^^^^^^ this
```

> ⚠️ **Forgetting to share is the most common failure, and its error is misleading.** The API
> returns **403**, not 404, so it reads like a credentials problem when it is a permissions one. If
> the token exchange succeeded but every call 403s, you have not shared the spreadsheets.

Do not create the worksheets/tabs by hand. The backup creates them, writes to a `__staging` tab, and
swaps — so a failed run never leaves a half-written sheet that looks complete.

## 5. Configure the application

> ⚠️ **`SHEETS_ENABLED=true`, lower case.** The parser accepts `true | false | 1 | 0` and nothing
> else, so `True` makes the API **refuse to boot** naming the variable. It fails closed rather than
> quietly disabling backups, which is the intent — but it is the first thing that went wrong when
> this was set up for real.

```bash
SHEETS_ENABLED=true
SHEETS_SERVICE_ACCOUNT_EMAIL=hixaa-dms-backup@hixaa-dms-backup.iam.gserviceaccount.com
SHEETS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n"
SHEETS_SPREADSHEET_ID_PRIMARY=1AbC...XyZ
SHEETS_SPREADSHEET_ID_TRANSACTIONS=1DeF...UvW
```

Three things about that private key, each of which has cost someone an evening:

- **Keep it on ONE line with literal `\n`**, exactly as it appears in the JSON. The adapter converts
  `\n` back to real newlines before signing. A real multi-line value will not survive `.env`.
- **Keep the double quotes.** `docs/HANDOFF.md` §3: dotenv strips `#` and everything after it in an
  *unquoted* value. A base64 key containing `#` would be silently truncated, and the failure looks
  like a bad key rather than a parsing bug.
- Everything else already has sensible defaults — `SHEETS_SYNC_CRON` is `0 2 * * *` (02:00 IST),
  `SHEETS_BATCH_SIZE` 1000, `SHEETS_MAX_REQUESTS_PER_MINUTE` 250 against Google's ~300 ceiling.

**The application refuses to boot if `SHEETS_ENABLED=true` and any of the three required values is
missing.** That check has existed since Phase 1 (`env.schema.ts`) and is deliberate — a backup that
silently does nothing is the failure this whole module is designed against.

## 6. Verify it

**Start read-only.** This authenticates and reads metadata without writing anything, and it tells
the two failure modes apart — see §7:

```bash
pnpm --filter @hixaa/api build && node apps/api/dist/scripts/verify-sheets-connection.js
```

```
adapter:         GOOGLE
service account: hixaa-dms-backup@…iam.gserviceaccount.com
✓ 1mNBny2p…QDec  (Users, Products, Distributors)
    authenticated and readable · 4 tab(s): Sheet1, Users, Products, Distributors
✓ 1-1kBfPb…s0KA  (Orders, Payments, Inventory)
```

Then the full end-to-end suite — export, masking, chunking, staging swap, restore diff and the
zero-row guard, against the live API:

```bash
node apps/api/dist/scripts/verify-backup.js
```

Restart both processes so the adapter is re-selected, then exercise the endpoint:

```bash
curl -X POST http://localhost:4000/api/v1/backup/sheets/sync -H "Authorization: Bearer $TOKEN"
```

Expect `202`. The work happens in the **worker** — the API never calls the Sheets API (ADR-0005), so
watch the worker's log, not the API's.

Then confirm it did something, rather than that it merely returned:

```bash
curl -s http://localhost:4000/api/v1/backup/jobs -H "Authorization: Bearer $TOKEN"
```

Every row carries `rowsProcessed` **and** `rowsExpected`. A run that exported 0 of 4,812 rows is
recorded `FAILED`, not `SUCCESS` — that guard exists because Phase 10 found every background job
silently reading an empty database (ADR-0021), and a backup is the worst place for that to happen.

The local adapter's own run is the reference: it exports Users, Products, Distributors, Orders,
Payments and Inventory, and `verify-backup.js` proves masking, chunking, checkpointing, the restore
diff and the zero-row guard end to end.

## 7. What to expect to go wrong first

These are the ones anticipated before the adapter had ever run. In the event, the first live setup
hit only the two configuration problems in §5 — but the list below still holds for a fresh server:

| Symptom | Almost certainly |
|---|---|
| `403` on every call, token exchange fine | The spreadsheets are not shared with the service account (§4) |
| `invalid_grant` on token exchange | The private key lost its `\n`, or the quotes were dropped |
| `400` naming a range | A worksheet title mismatch — delete the tabs and let the backup create them |
| `429` storms | Lower `SHEETS_MAX_REQUESTS_PER_MINUTE`. The limiter is tuned to documentation, not observation |
| Works, then fails at ~10M cells | The shard limit in §0. Split further, or accept Sheets is not the recovery path |

The retry/backoff policy honours a `Retry-After` header and otherwise backs off exponentially over
five attempts. Those numbers are written against Google's published limits and **have still not been
observed under real pressure** — the first live runs never approached the quota (§9), so the backoff
path remains the least-tested code in the adapter. If a large export ever behaves oddly, start
there; it is confined to `google-sheets.adapter.ts`.

## 8. Turning it off

`SHEETS_ENABLED=false` reverts to the local CSV adapter. Nothing else changes; no code, no
migration. The spreadsheets are left exactly as they were.

---

## 9. Measured, once it was real

From the first live runs, so these are observations rather than estimates:

| | |
|---|---|
| Requests per entity | **8** |
| Requests per full backup | **~48**, against a 250/min limiter |
| Time per entity | ~4 s, almost entirely API latency |
| Rows exported | Users 7 · Products 14 · Distributors 2 · Orders 5 · Payments 10 · Inventory 2 |

`SyncJob.apiRequests` records the **per-run** figure. It initially recorded the adapter's running
process total — 112, 120, 128… across six entities — which read as though the last entity cost 160
requests when it cost 8. Fixed. If that number ever looks implausible again, distrust it before you
distrust the quota.

Both spreadsheets keep the default `Sheet1` tab Google creates. Harmless; the backup never touches
it. Delete it by hand if you prefer a tidy book.
