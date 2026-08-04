#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Restore from an encrypted backup.
#
#   ./infra/scripts/restore.sh <backup-file>
#
# Deliberately awkward. Restores are rare, high-stakes, and should feel that
# way: this restores into a SCRATCH database first, reports row counts, and only
# promotes after you type the database name to confirm.
#
# An untested backup is a hypothesis, not a backup. Rehearse this quarterly on
# staging — the moment you need it is the worst possible time to discover the
# dump was empty.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

BACKUP_FILE="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/infra/compose/docker-compose.prod.yml"
ENV_FILE="$ROOT/.env.production"

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

log()  { printf '\033[0;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[0;32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31m✗\033[0m %s\n' "$*" >&2; }

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

[[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]] || {
  fail "Usage: restore.sh <backup-file>"
  echo "Available:"; ls -1t "$ROOT/backups/daily" 2>/dev/null | head -10
  exit 1
}

SCRATCH_DB="${POSTGRES_DB}_restore_$(date +%s)"
WORK_FILE="$BACKUP_FILE"

if [[ "$BACKUP_FILE" == *.age ]]; then
  command -v age >/dev/null 2>&1 || { fail "age is required to decrypt"; exit 1; }
  [[ -n "${BACKUP_AGE_IDENTITY:-}" ]] || { fail "BACKUP_AGE_IDENTITY is not set"; exit 1; }
  WORK_FILE="$(mktemp)"
  log "Decrypting"
  age -d -i "$BACKUP_AGE_IDENTITY" -o "$WORK_FILE" "$BACKUP_FILE"
  trap 'rm -f "$WORK_FILE"' EXIT
fi

# ── Stage 1: restore into a scratch database and inspect it ────────────────
log "Restoring into scratch database $SCRATCH_DB"
compose exec -T postgres createdb -U "$POSTGRES_USER" "$SCRATCH_DB"
compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$SCRATCH_DB" --no-owner --no-acl \
  < "$WORK_FILE" || fail "pg_restore reported errors (often benign for ownership)"

log "Row counts in the restored copy:"
compose exec -T postgres psql -U "$POSTGRES_USER" -d "$SCRATCH_DB" -tAc "
  SELECT relname || ': ' || n_live_tup
  FROM pg_stat_user_tables WHERE n_live_tup > 0
  ORDER BY n_live_tup DESC LIMIT 20;"

TABLES=$(compose exec -T postgres psql -U "$POSTGRES_USER" -d "$SCRATCH_DB" -tAc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public';" | tr -d '[:space:]')
ok "Restored $TABLES tables into $SCRATCH_DB"

[[ "$TABLES" -gt 0 ]] || { fail "Restored database is empty — refusing to promote"; exit 1; }

# ── Stage 2: explicit confirmation before touching live data ───────────────
echo
fail "PROMOTING WILL REPLACE THE LIVE DATABASE '$POSTGRES_DB'."
echo "Type the database name to confirm, or anything else to abort:"
read -r CONFIRM
[[ "$CONFIRM" == "$POSTGRES_DB" ]] || {
  log "Aborted. The scratch copy remains at $SCRATCH_DB for inspection."
  exit 0
}

log "Stopping application containers (database stays up)"
compose stop api worker web

log "Swapping databases"
compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c \
  "ALTER DATABASE \"$POSTGRES_DB\" RENAME TO \"${POSTGRES_DB}_replaced_$(date +%s)\";"
compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c \
  "ALTER DATABASE \"$SCRATCH_DB\" RENAME TO \"$POSTGRES_DB\";"

log "Restarting application"
compose up -d api worker web

ok "Restore complete. The previous database was renamed, not dropped — remove it manually once verified."
