#!/usr/bin/env bash
#
# Restore an encrypted database backup. Phase 10.3, ADR-0024.
#
#   scripts/restore.sh <backup.dump.gpg> <target-database-url> [--force]
#
# gpg --decrypt → pg_restore → report row counts. The row counts are the point:
# "pg_restore exited 0" says the command ran, not that the data arrived.
#
# ── Guards, and why each exists ────────────────────────────────────────────
#
#   • The target database must be named EXPLICITLY. There is no default and no
#     fallback to DATABASE_URL — a restore that picks its own target is one
#     keystroke from overwriting production.
#   • A non-empty target is refused without --force.
#   • `hixaa_dms` is refused outright. It is a pre-existing database from an
#     earlier attempt at this project, deliberately left untouched
#     (docs/HANDOFF.md §3), and it is one character away from `hixaa_dms_dev`.
#
# Exit codes: 0 success · 1 usage/guard · 2 decrypt/restore failure
set -euo pipefail

# $1 is the message, $2 the exit code — never "$*", which printed the exit
# code as part of the error text.
fail() { echo "restore.sh: $1" >&2; exit "${2:-1}"; }

BACKUP_FILE="${1:-}"
TARGET_URL="${2:-}"
FORCE="${3:-}"

[ -n "$BACKUP_FILE" ] && [ -n "$TARGET_URL" ] || fail "usage: restore.sh <backup.dump.gpg> <target-database-url> [--force]

Both arguments are required. There is deliberately no default target: a
restore that chooses its own destination is one keystroke from overwriting
production."

[ -f "$BACKUP_FILE" ] || fail "no such backup file: $BACKUP_FILE"
command -v pg_restore >/dev/null || fail "pg_restore is not installed"
command -v gpg >/dev/null || fail "gpg is not installed"

# Same Prisma-vs-libpq problem as backup.sh: `?schema=public` is Prisma's and
# pg_restore rejects it.
strip_prisma_params() {
  local url="$1" query base
  case "$url" in
    *\?*) base="${url%%\?*}"; query="${url#*\?}" ;;
    *) printf '%s' "$url"; return ;;
  esac
  local kept="" IFS='&'
  for param in $query; do
    case "$param" in
      schema=*|connection_limit=*|pool_timeout=*|pgbouncer=*|connect_timeout=*) continue ;;
      '') continue ;;
      *) kept="${kept:+$kept&}$param" ;;
    esac
  done
  printf '%s%s' "$base" "${kept:+?$kept}"
}
TARGET_URL="$(strip_prisma_params "$TARGET_URL")"
TARGET_DB="$(printf '%s' "$TARGET_URL" | sed -e 's|.*/||' -e 's|?.*||')"

# The one database this script will never write to. See docs/HANDOFF.md §3.
if [ "$TARGET_DB" = "hixaa_dms" ]; then
  fail "refusing to restore into 'hixaa_dms'.

That is a PRE-EXISTING database from an earlier attempt at this project, kept
deliberately untouched (docs/HANDOFF.md §3). You almost certainly meant
'hixaa_dms_dev' or a scratch database. If you genuinely intend to overwrite it,
do it by hand so the decision is yours and not this script's."
fi

# ── Integrity ──────────────────────────────────────────────────────────────
if [ -f "$BACKUP_FILE.sha256" ] && command -v shasum >/dev/null; then
  EXPECTED="$(cat "$BACKUP_FILE.sha256")"
  ACTUAL="$(shasum -a 256 "$BACKUP_FILE" | awk '{print $1}')"
  [ "$EXPECTED" = "$ACTUAL" ] \
    || fail "checksum mismatch — the backup file is corrupt or truncated
  expected $EXPECTED
  actual   $ACTUAL" 2
  echo "restore.sh: checksum ok"
fi

# ── Is the target safe to write to? ────────────────────────────────────────
if psql "$TARGET_URL" -c 'SELECT 1' >/dev/null 2>&1; then
  TABLES=$(psql "$TARGET_URL" -t -A -c \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo 0)
  if [ "${TABLES:-0}" -gt 0 ] && [ "$FORCE" != "--force" ]; then
    fail "target database '$TARGET_DB' already has $TABLES table(s).

Refusing to restore over it without --force. Restores are rare, high-stakes and
irreversible, and they should feel that way."
  fi
else
  fail "cannot connect to target database: $TARGET_URL"
fi

# ── Decrypt ────────────────────────────────────────────────────────────────
TMP="$(mktemp -t hixaa-restore)"
trap 'rm -f "$TMP"' EXIT

# Needs the PRIVATE key, which by design does not live on the backup host.
if ! gpg --batch --yes --quiet --output "$TMP" --decrypt "$BACKUP_FILE" 2>/tmp/hixaa-restore-gpg.err; then
  fail "gpg decryption failed: $(head -3 /tmp/hixaa-restore-gpg.err)

The private key is required here and is deliberately NOT kept on the machine
that writes backups (ADR-0024). Import it, or run this where it lives." 2
fi

DUMP_BYTES=$(wc -c < "$TMP" | tr -d ' ')
[ "$DUMP_BYTES" -gt 0 ] || fail "decrypted to a zero-byte file" 2

# ── Restore ────────────────────────────────────────────────────────────────
START=$(date +%s)
# --clean --if-exists so a --force restore replaces rather than colliding.
# Errors are NOT ignored: --exit-on-error, because a restore that half-worked
# and reported success is the failure mode this whole module exists against.
if ! pg_restore --dbname="$TARGET_URL" --no-owner --no-privileges \
      --clean --if-exists --exit-on-error "$TMP" 2>/tmp/hixaa-restore.err; then
  fail "pg_restore failed: $(tail -5 /tmp/hixaa-restore.err)" 2
fi
END=$(date +%s)

# ── Report row counts, not an exit code ────────────────────────────────────
ROWS=$(psql "$TARGET_URL" -t -A -F'|' -c "
  SELECT relname, n_live_tup
  FROM pg_stat_user_tables
  WHERE schemaname='public' AND n_live_tup > 0
  ORDER BY n_live_tup DESC
  LIMIT 12;" 2>/dev/null || true)

TABLE_COUNT=$(psql "$TARGET_URL" -t -A -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")

echo
echo "restore.sh: restored into '$TARGET_DB' in $((END - START))s"
echo "  tables: $TABLE_COUNT"
echo "  largest tables (name|rows):"
echo "$ROWS" | sed 's/^/    /'
echo
echo "⚠️  Row counts above are planner estimates from pg_stat_user_tables and can"
echo "    lag. Run ANALYZE, or count the tables you actually care about, before"
echo "    declaring a restore verified."
