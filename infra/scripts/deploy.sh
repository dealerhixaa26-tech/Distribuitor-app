#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy to the Hostinger VPS.
#
#   ./infra/scripts/deploy.sh [tag]
#
# Order matters and is not negotiable:
#   1. Back up FIRST. This is the difference between a bad migration being a
#      ten-minute inconvenience and a catastrophe.
#   2. Migrate as a one-shot container that must complete before app start.
#   3. Roll the apps, then verify readiness.
#   4. On a failed healthcheck, roll back automatically and exit non-zero.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

TAG="${1:-latest}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/infra/compose/docker-compose.prod.yml"
ENV_FILE="$ROOT/.env.production"
STATE_DIR="$ROOT/.deploy"
PREVIOUS_TAG_FILE="$STATE_DIR/previous-tag"
STARTED_AT=$(date +%s)

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

log()  { printf '\033[0;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[0;32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31m✗\033[0m %s\n' "$*" >&2; }

# Any unexpected error triggers the same rollback path as a failed healthcheck.
on_error() {
  local line=$1
  fail "Deploy failed at line $line"
  rollback "unexpected error at line $line"
}
trap 'on_error $LINENO' ERR

rollback() {
  local reason="$1"
  if [[ -f "$PREVIOUS_TAG_FILE" ]]; then
    local previous
    previous="$(cat "$PREVIOUS_TAG_FILE")"
    fail "Rolling back to $previous — $reason"
    TAG="$previous" compose up -d --no-deps api worker web || true
  else
    fail "No previous tag recorded; manual intervention required — $reason"
  fi
  notify "failure" "$reason"
  exit 1
}

# Deployment notifications go to the OPS mailbox, never the business one.
notify() {
  local status="$1" detail="${2:-}"
  local duration=$(( $(date +%s) - STARTED_AT ))
  compose run --rm --no-deps -T api node -e "
    const { execSync } = require('child_process');
    console.log(JSON.stringify({ status: '$status', tag: '$TAG', durationSeconds: $duration, detail: '$detail' }));
  " 2>/dev/null || true
  log "Deploy $status (tag $TAG, ${duration}s) ${detail}"
}

[[ -f "$ENV_FILE" ]] || { fail "Missing $ENV_FILE"; exit 1; }
mkdir -p "$STATE_DIR"

log "Deploying tag: $TAG"

# ── 1. Record what we are replacing, so rollback has a target ────────────────
CURRENT_TAG="$(compose config 2>/dev/null | grep -m1 -oE 'image: .*/api:.*' | sed 's/.*://' || echo '')"
[[ -n "$CURRENT_TAG" ]] && echo "$CURRENT_TAG" > "$PREVIOUS_TAG_FILE"

# ── 2. Back up BEFORE touching anything ─────────────────────────────────────
log "Taking pre-deploy backup"
"$ROOT/infra/scripts/backup.sh" pre-deploy
ok "Backup complete"

# ── 3. Pull / build ─────────────────────────────────────────────────────────
log "Building images"
TAG="$TAG" compose build --pull
ok "Images ready"

# ── 4. Migrate (one-shot; must complete before apps start) ──────────────────
log "Applying database migrations"
TAG="$TAG" compose up --exit-code-from migrate migrate || rollback "migration failed"
ok "Migrations applied"

# ── 5. Roll the application containers ──────────────────────────────────────
log "Starting application"
TAG="$TAG" compose up -d --no-deps api worker web
ok "Containers started"

# ── 6. Verify readiness before declaring success ────────────────────────────
log "Waiting for readiness"
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:4000/health/ready >/dev/null 2>&1; then
    ok "API ready after ${attempt}0s"
    break
  fi
  [[ $attempt -eq 30 ]] && rollback "API did not become ready within 60s"
  sleep 2
done

curl -fsS --max-time 5 http://127.0.0.1:3000/dashboard >/dev/null 2>&1 \
  || rollback "web did not become ready"
ok "Web ready"

# ── 7. Housekeeping ─────────────────────────────────────────────────────────
log "Pruning dangling images"
docker image prune -f >/dev/null 2>&1 || true

trap - ERR
notify "success"
ok "Deploy complete in $(( $(date +%s) - STARTED_AT ))s"
