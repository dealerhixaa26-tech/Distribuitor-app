# 29 — Database backup and restore runbook

> **`pg_dump` is the disaster-recovery mechanism.** Google Sheets (`docs/28`) is a convenience copy
> for human inspection and cannot hold the stated scale. If you are recovering from a real
> incident, you are in this document, not that one.
>
> Rehearsed end to end on 2026-08-05. Numbers in §5 are measured, not estimated.

---

## 1. What runs, and when

| | When (IST) | What |
|---|---|---|
| **Backup** | 01:30 nightly | `pg_dump -Fc` → GPG public-key encrypt → dated file → prune |
| **Rehearsal** | 04:00 on the 1st | Restore the newest backup into a scratch DB, compare every table's row count |
| Sheets sync | 02:00 nightly | Convenience copy (`docs/28`) |
| Retention purge | 03:00 nightly | Deletes expired sessions, tokens, old outbox rows |

The backup runs **before** both the Sheets sync (no contention) and the retention purge, so a
backup captures the rows the purge is about to delete.

Both are `@Cron` jobs in the **worker** (`apps/api/src/jobs/backup.processor.ts`). If the worker is
not running, neither happens — see `docs/HANDOFF.md` §4.23, which exists because that went unnoticed
for three phases.

## 2. Setting it up

### The key — do this on YOUR machine, not the server

```bash
gpg --full-generate-key                       # RSA 3072+, no expiry, real email
gpg --armor --export you@example.com > hixaa-backup.pub
```

Copy **only the public key** to the server:

```bash
gpg --import hixaa-backup.pub
```

```bash
BACKUP_ENABLED=true
BACKUP_GPG_RECIPIENT=you@example.com
BACKUP_DIR=/mnt/backups          # a MOUNTED path, not the database's own disk
```

> **Why public-key rather than a passphrase.** The server holds only the public key: it can create
> backups and cannot read them. A passphrase in `.env` would sit next to the database it protects
> and die with the machine. ADR-0024.
>
> **The private key is the recovery plan.** Keep it in a password manager and one offline copy. A
> backup you cannot decrypt is not a backup, and this is the single easiest way to end up with a
> shelf of unreadable archives.

Production **refuses to boot** without `BACKUP_ENABLED=true` and a recipient — an unencrypted
backup is a copy of every customer, price and bank detail in a file with no lock on it.

### `BACKUP_DIR` must not be the database's disk

A backup on the same disk protects against neither disk failure nor the machine going away. Mount
object storage, or `rsync` the directory off-box on a schedule. The `StorageService` seam already
exists for when this moves to S3-compatible storage in Phase 11.

## 3. Verifying it

```bash
pnpm --filter @hixaa/api build && node apps/api/dist/scripts/verify-db-backup.js
```

Takes a real backup, restores it into a scratch database, and compares **every table's row count**
between source and restore:

```
✓ pg_dump → gpg produced an encrypted file
    386308 bytes → 117597 encrypted in 0s · 2 retained
✓ every table restored with an identical row count
    81/81 tables · 1347/1347 rows · 1s
✓ no per-table mismatches
```

The per-table check is not redundant with the total: two tables wrong in opposite directions would
net to the right sum.

## 4. Restoring, for real

```bash
scripts/restore.sh /mnt/backups/hixaa-hixaa_dms-20260805T013000Z.dump.gpg \
  "postgresql://user@host:5432/hixaa_dms_dev" --force
```

Both arguments are required. There is deliberately no default target: a restore that picks its own
destination is one keystroke from overwriting production.

**Guards, all exercised:**

| Guard | Behaviour |
|---|---|
| Checksum | Compares against the `.sha256` written at backup time; refuses a truncated or altered file |
| Non-empty target | Refused without `--force` |
| `hixaa_dms` | **Refused outright** — it is a pre-existing database from an earlier attempt (`HANDOFF` §3) and one character from `hixaa_dms_dev` |
| Partial restore | `pg_restore --exit-on-error`; a half-restore fails rather than reporting success |

After restoring, **verify it is a working database, not just rows**. The rehearsal checks that 26
triggers, 355 indexes, 73 CHECK constraints, 132 foreign keys, 53 enums and 50 functions all came
back — and the immutability triggers were confirmed to actually fire:

```
ERROR: Invoice HTPL/INV/2026-27/00001 is PAID and its financial identity is frozen.
```

A restore with rows but no triggers would pass a row count and still be broken.

## 5. Measured

From the rehearsal on `hixaa_dms_dev` (81 tables, 1,347 rows — a development dataset):

| | |
|---|---|
| Plaintext dump | 386,308 bytes |
| Encrypted | 117,597 bytes (~30%, `-Fc` is already compressed) |
| Backup duration | <1 s |
| Restore duration | ~1 s |
| Row fidelity | 1,347 / 1,347, table by table |
| Schema fidelity | triggers, indexes, constraints, enums, functions all identical |

⚠️ **These numbers are from a tiny dataset.** They say the mechanism is correct; they say nothing
about how long a production dump takes. Re-measure after the Phase 11 load test, and raise the
30-minute timeout in `database-backup.service.ts` if a real dump approaches it.

## 6. Retention

Daily for 14, then one per week for 8, then one per month for 12. Configurable via
`BACKUP_KEEP_DAILY` / `_WEEKLY` / `_MONTHLY`.

The prune only ever deletes files matching the exact `hixaa-*.dump.gpg` pattern it created, and
never touches anything else in the directory.

## 7. When something goes wrong

| Symptom | Cause |
|---|---|
| `invalid URI query parameter: "schema"` | A `DATABASE_URL` reaching `pg_dump` unsanitised. Both scripts strip Prisma-only params (`schema`, `connection_limit`, `pool_timeout`, `pgbouncer`); if you invoke `pg_dump` by hand, strip them yourself |
| `No GPG public key found` | The public key was never imported on this host |
| `gpg decryption failed` | You are on the backup host. The private key deliberately is not here — restore where it lives |
| `checksum mismatch` | The file is truncated or altered. Use an older backup; do not force past this |
| Backup silently absent | The **worker is not running**. `pnpm dev` starts it only since Phase 10 — `turbo.json` had no `dev:worker` task |
| Rehearsal fails, scratch DB remains | Deliberate: it is kept on failure so there is something to inspect. Dropped on success |

## 8. What is deliberately not here

- **Point-in-time recovery.** No WAL archiving. Nightly granularity means up to 24 hours of loss in
  the worst case. PITR needs continuous archiving to off-box storage and is a Phase 11 decision to
  take with the VPS layout, not a thing to half-build now.
- **Automated off-box copy.** `BACKUP_DIR` is expected to *be* a mounted remote path. Wiring an
  upload into the job would duplicate the `StorageService` seam that already exists.
- **Restoring the Sheets backup.** Refused by design — see ADR-0024 and `restore.service.ts`.
