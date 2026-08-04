#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Encrypted PostgreSQL backup.
#
#   ./infra/scripts/backup.sh [label]
#
# This is the REAL disaster-recovery mechanism. The Google Sheets sync is a
# convenience copy for human inspection — it caps at 10 million cells per
# spreadsheet, has no transactional consistency, and no point-in-time recovery.
# Relying on it alone to restore a million-row database would be negligent.
# See docs/12-recommendations.md §A5.
#
# Retention: 7 daily · 4 weekly · 6 monthly.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

LABEL="${1:-scheduled}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/infra/compose/docker-compose.prod.yml"
ENV_FILE="$ROOT/.env.production"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
STARTED_AT=$(date +%s)
STAMP="$(date +%Y%m%d-%H%M%S)"

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

mkdir -p "$BACKUP_DIR"/{daily,weekly,monthly}

TARGET="$BACKUP_DIR/daily/hixaa-${STAMP}-${LABEL}.dump"

log()  { printf '\033[0;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[0;32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31m✗\033[0m %s\n' "$*" >&2; }

# -Fc is the custom format: compressed, and restorable table-by-table, which
# matters when recovering one corrupted table rather than the whole database.
log "Dumping ${POSTGRES_DB}"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-acl \
  > "$TARGET" || { fail "pg_dump failed"; exit 1; }

SIZE=$(stat -f%z "$TARGET" 2>/dev/null || stat -c%s "$TARGET")
[[ "$SIZE" -gt 1024 ]] || { fail "Dump is suspiciously small (${SIZE}B) — aborting"; rm -f "$TARGET"; exit 1; }
ok "Dumped $(( SIZE / 1024 / 1024 ))MB"

# Encrypt before the file ever leaves this host. An unencrypted dump in object
# storage is a full copy of every distributor's commercial terms.
if command -v age >/dev/null 2>&1 && [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  log "Encrypting"
  age -r "$BACKUP_AGE_RECIPIENT" -o "${TARGET}.age" "$TARGET"
  shred -u "$TARGET" 2>/dev/null || rm -f "$TARGET"
  TARGET="${TARGET}.age"
  ok "Encrypted"
else
  fail "age not configured (BACKUP_AGE_RECIPIENT unset) — backup is UNENCRYPTED"
fi

# Promote copies for weekly/monthly retention.
[[ "$(date +%u)" == "7" ]] && cp "$TARGET" "$BACKUP_DIR/weekly/"
[[ "$(date +%d)" == "01" ]] && cp "$TARGET" "$BACKUP_DIR/monthly/"

log "Applying retention policy"
find "$BACKUP_DIR/daily"   -type f -mtime +7   -delete
find "$BACKUP_DIR/weekly"  -type f -mtime +28  -delete
find "$BACKUP_DIR/monthly" -type f -mtime +180 -delete

# Off-box copy. A backup on the same disk as the database protects against
# operator error but not against losing the VPS.
if [[ -n "${BACKUP_REMOTE_TARGET:-}" ]]; then
  log "Copying off-box"
  rsync -az --partial "$TARGET" "$BACKUP_REMOTE_TARGET/" \
    && ok "Copied off-box" \
    || fail "Off-box copy FAILED — backup exists only on this host"
else
  fail "BACKUP_REMOTE_TARGET unset — backup exists only on this host"
fi

ok "Backup complete in $(( $(date +%s) - STARTED_AT ))s: $(basename "$TARGET")"
