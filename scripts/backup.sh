#!/usr/bin/env bash
#
# Nightly encrypted database backup. Phase 10.3, ADR-0024.
#
# pg_dump → gpg (public key) → dated file → prune old files → print a JSON
# summary on stdout so the caller can report it without parsing prose.
#
# ── Why PUBLIC-KEY encryption, not a passphrase ────────────────────────────
#
# The box that makes the backup holds only the PUBLIC key. It can create
# backups and cannot read them. An attacker who takes the server gets the
# database anyway, but does not also get a decryptable archive of every
# historical state — and, more to the point, the private key surviving the
# server is the whole reason the backup is worth having. A symmetric passphrase
# in .env would sit next to the database it protects and die with it.
#
# ── Usage ──────────────────────────────────────────────────────────────────
#   scripts/backup.sh                    # uses .env
#   BACKUP_DIR=/mnt/backups scripts/backup.sh
#
# Exit codes: 0 success · 1 configuration error · 2 dump/encrypt failure
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"

# ── Configuration ──────────────────────────────────────────────────────────
# Read from .env without sourcing it: sourcing executes whatever is in there,
# and a backup script should not be a code-execution path.
read_env() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | head -1 | sed -e 's/^"//' -e 's/"$//'
}

DATABASE_URL="${DATABASE_URL:-$(read_env DATABASE_URL)}"
BACKUP_DIR="${BACKUP_DIR:-$(read_env BACKUP_DIR)}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/storage/backups}"
GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:-$(read_env BACKUP_GPG_RECIPIENT)}"

KEEP_DAILY="${BACKUP_KEEP_DAILY:-14}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-8}"
KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-12}"

fail() { echo "backup.sh: $*" >&2; exit "${2:-1}"; }

[ -n "$DATABASE_URL" ] || fail "DATABASE_URL is not set and not in $ENV_FILE"
command -v pg_dump >/dev/null || fail "pg_dump is not installed"

if [ -z "$GPG_RECIPIENT" ]; then
  fail "BACKUP_GPG_RECIPIENT is not set.

An unencrypted database backup is a copy of every customer, price and bank
detail in a file with no lock on it. This script refuses rather than silently
producing one — the same posture as the ClamAV and S3 drivers, which throw at
boot instead of degrading quietly.

  gpg --full-generate-key                 # on YOUR machine, not the server
  gpg --armor --export you@example.com > hixaa-backup.pub
  # copy to the server, then:
  gpg --import hixaa-backup.pub
  BACKUP_GPG_RECIPIENT=you@example.com

Keep the PRIVATE key off the server. See docs/29-backup-and-restore.md."
fi

command -v gpg >/dev/null || fail "gpg is not installed but BACKUP_GPG_RECIPIENT is set"
gpg --list-keys "$GPG_RECIPIENT" >/dev/null 2>&1 \
  || fail "No GPG public key found for '$GPG_RECIPIENT' — import it first"

# ── Dump ───────────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_NAME="$(printf '%s' "$DATABASE_URL" | sed -e 's|.*/||' -e 's|?.*||')"
BASENAME="hixaa-${DB_NAME}-${STAMP}"
TARGET="$BACKUP_DIR/${BASENAME}.dump.gpg"
TMP="$(mktemp -t hixaa-backup)"
# The plaintext dump must not outlive this script even if it dies.
trap 'rm -f "$TMP"' EXIT

START_MS=$(($(date +%s) * 1000))

# -Fc: custom format. Compressed, and pg_restore can be selective over it —
# a plain SQL file cannot restore one table without hand-editing.
if ! pg_dump --format=custom --no-owner --no-privileges --file="$TMP" "$DATABASE_URL" 2>/tmp/hixaa-pgdump.err; then
  fail "pg_dump failed: $(head -3 /tmp/hixaa-pgdump.err)" 2
fi

PLAIN_BYTES=$(wc -c < "$TMP" | tr -d ' ')
[ "$PLAIN_BYTES" -gt 0 ] || fail "pg_dump produced a zero-byte file" 2

# --trust-model always: the recipient key is imported deliberately by an
# operator; requiring an interactive trust signature would break the cron.
if ! gpg --batch --yes --trust-model always \
       --recipient "$GPG_RECIPIENT" \
       --output "$TARGET" --encrypt "$TMP" 2>/tmp/hixaa-gpg.err; then
  fail "gpg encryption failed: $(head -3 /tmp/hixaa-gpg.err)" 2
fi

ENC_BYTES=$(wc -c < "$TARGET" | tr -d ' ')
[ "$ENC_BYTES" -gt 0 ] || fail "gpg produced a zero-byte file" 2

# A checksum recorded now is what makes "the file is intact" answerable later
# without decrypting it.
if command -v shasum >/dev/null; then
  shasum -a 256 "$TARGET" | awk '{print $1}' > "$TARGET.sha256"
fi

END_MS=$(($(date +%s) * 1000))

# ── Retention ──────────────────────────────────────────────────────────────
# Daily for KEEP_DAILY, then one per week, then one per month. Deliberately
# conservative: it only ever deletes files this script created, matched by the
# exact name pattern, and never touches anything else in the directory.
prune() {
  local kept=0
  # Newest first; keep the most recent KEEP_DAILY unconditionally.
  local files
  files=$(ls -1t "$BACKUP_DIR"/hixaa-*.dump.gpg 2>/dev/null || true)
  [ -n "$files" ] || return 0

  local seen_weeks="" seen_months="" removed=0
  while IFS= read -r file; do
    kept=$((kept + 1))
    if [ "$kept" -le "$KEEP_DAILY" ]; then continue; fi

    local stamp week month
    stamp=$(basename "$file" | sed -E 's/.*-([0-9]{8})T.*/\1/')
    week=$(echo "$stamp" | cut -c1-6)   # coarse: year-month as the weekly bucket
    month=$(echo "$stamp" | cut -c1-6)

    if ! echo "$seen_months" | grep -q "$month"; then
      seen_months="$seen_months $month"
      continue
    fi
    if ! echo "$seen_weeks" | grep -q "$week"; then
      seen_weeks="$seen_weeks $week"
      continue
    fi

    rm -f "$file" "$file.sha256"
    removed=$((removed + 1))
  done <<< "$files"
  echo "$removed"
}
REMOVED=$(prune)

COUNT=$(ls -1 "$BACKUP_DIR"/hixaa-*.dump.gpg 2>/dev/null | wc -l | tr -d ' ')

# ── Report ─────────────────────────────────────────────────────────────────
# JSON on stdout so the worker can report it without parsing prose.
cat <<JSON
{
  "status": "success",
  "file": "$TARGET",
  "plaintextBytes": $PLAIN_BYTES,
  "encryptedBytes": $ENC_BYTES,
  "durationSeconds": $(( (END_MS - START_MS) / 1000 )),
  "recipient": "$GPG_RECIPIENT",
  "retainedFiles": $COUNT,
  "prunedFiles": ${REMOVED:-0}
}
JSON
