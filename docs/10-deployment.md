# 10 — Deployment (Hostinger VPS, Docker Compose)

> Phase 0 deliverable. Status: **Awaiting approval**

---

## 1. Target topology

```
                    Internet
                       │  443 / 80
              ┌────────▼─────────┐
              │  Nginx (host)    │  TLS termination, Let's Encrypt,
              │                  │  rate limiting, gzip/brotli, static cache
              └────┬──────┬──────┘
                   │      │
     ┌─────────────▼─┐  ┌─▼──────────────┐
     │ web  (Next.js)│  │ api  (NestJS)  │
     │ :3000         │  │ :4000          │
     └───────────────┘  └─┬────────┬─────┘
                          │        │
              ┌───────────▼──┐  ┌──▼──────────┐   ┌──────────────┐
              │ postgres:16  │  │ redis:7     │   │ worker       │
              │ volume: pgdata│  │ volume: rdb│   │ (BullMQ)     │
              └──────────────┘  └─────────────┘   └──────────────┘
```

Six services. Postgres and Redis are **not** published to the host network — they are reachable only
on the internal Compose network. This is the single most important line in the deployment: an
exposed Postgres port on a public VPS is scanned and attacked within hours.

---

## 2. Sizing

| Service | Memory limit | Notes |
|---|---|---|
| postgres | 1.5 GB | `shared_buffers=384MB`, `effective_cache_size=1GB`, `work_mem=8MB` |
| redis | 256 MB | `maxmemory-policy=noeviction` — evicting a queued job is data loss |
| api | 768 MB | `--max-old-space-size=640` |
| worker | 512 MB | PDF and Excel generation are the memory-hungry paths |
| web | 512 MB | |
| nginx | 64 MB | |

**Minimum viable VPS: 4 GB RAM / 2 vCPU / 80 GB NVMe.** Recommended: **8 GB / 4 vCPU**, which leaves
headroom for backup jobs, report generation, and a staging stack on the same box. A 2 GB plan will
technically boot and will thrash under any real report generation — worth confirming before launch.

---

## 3. Images

Multi-stage, Alpine-based, non-root, with a healthcheck:

```dockerfile
# infra/docker/api.Dockerfile
FROM node:24-alpine AS base
RUN corepack enable && apk add --no-cache dumb-init
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm --filter @hixaa/contracts build && \
    pnpm --filter @hixaa/api prisma:generate && \
    pnpm --filter @hixaa/api build && \
    pnpm prune --prod

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -S nodejs
COPY --from=build --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nodejs:nodejs /app/apps/api/dist ./dist
COPY --from=build --chown=nodejs:nodejs /app/apps/api/prisma ./prisma
USER nodejs
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/health/live').then(r=>process.exit(r.ok?0:1))"
ENTRYPOINT ["dumb-init","--"]
CMD ["node","dist/main.js"]
```

The worker reuses the API image with a different command — same code, different entrypoint, so the
two can never drift out of sync.

---

## 4. Compose (production)

```yaml
# infra/compose/docker-compose.prod.yml   (abridged)
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment: [POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgres/postgresql.conf:/etc/postgresql/postgresql.conf:ro
    command: postgres -c config_file=/etc/postgresql/postgresql.conf
    healthcheck:
      test: ["CMD-SHELL","pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 10s
      retries: 5
    networks: [internal]          # ← no ports: published

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --requirepass ${REDIS_PASSWORD} --appendonly yes --maxmemory-policy noeviction
    volumes: [redisdata:/data]
    networks: [internal]

  migrate:                        # one-shot, runs to completion before api starts
    image: hixaa/api:${TAG}
    command: ["pnpm","prisma","migrate","deploy"]
    depends_on: { postgres: { condition: service_healthy } }
    env_file: [../../.env.production]
    networks: [internal]
    restart: "no"

  api:
    image: hixaa/api:${TAG}
    restart: unless-stopped
    depends_on:
      migrate: { condition: service_completed_successfully }
      redis:   { condition: service_started }
    env_file: [../../.env.production]
    networks: [internal, web]
    deploy: { resources: { limits: { memory: 768M } } }

  worker:
    image: hixaa/api:${TAG}
    command: ["node","dist/worker.js"]
    restart: unless-stopped
    depends_on:
      migrate: { condition: service_completed_successfully }
    env_file: [../../.env.production]
    networks: [internal]

  web:
    image: hixaa/web:${TAG}
    restart: unless-stopped
    depends_on: [api]
    networks: [web]

volumes: { pgdata: , redisdata: , uploads: }
networks:
  internal: { internal: true }    # ← no route to the internet
  web: {}
```

The `migrate` service uses `service_completed_successfully`, which guarantees migrations finish
**before** the API or worker starts, and that they run exactly once even if `api` is scaled.

---

## 5. Nginx

Runs on the host (not containerised) so that `certbot`'s renewal hook is straightforward and TLS
survives a full Compose teardown.

```nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=100r/s;
limit_req_zone $binary_remote_addr zone=auth:10m rate=5r/m;

server {
  listen 443 ssl http2;
  server_name dms.hixaa.com;

  ssl_certificate     /etc/letsencrypt/live/dms.hixaa.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dms.hixaa.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers off;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
  client_max_body_size 50m;

  location /api/v1/auth/ { limit_req zone=auth burst=5 nodelay;    proxy_pass http://127.0.0.1:4000; }
  location /api/        { limit_req zone=api burst=200 nodelay;    proxy_pass http://127.0.0.1:4000; }
  location /api/v1/notifications/stream {
      proxy_pass http://127.0.0.1:4000;
      proxy_buffering off; proxy_read_timeout 3600s;   # SSE
  }
  location /            { proxy_pass http://127.0.0.1:3000; }
}
server { listen 80; server_name dms.hixaa.com; return 301 https://$host$request_uri; }
```

---

## 6. Scripts (`infra/scripts/`)

| Script | Behaviour |
|---|---|
| `bootstrap.sh` | First-run VPS setup: Docker, Compose, ufw (22/80/443 only), fail2ban, swap, unattended-upgrades, certbot, directory layout |
| `deploy.sh` | Pull → build → **backup first** → `migrate` → rolling restart → healthcheck → ops email. **Aborts and rolls back on a failed healthcheck** |
| `backup.sh` | `pg_dump -Fc` → `age` encrypt → local `keep 7 daily / 4 weekly` → off-box copy → ops email with size and duration |
| `restore.sh` | Interactive, requires typing the database name to confirm, restores to a scratch DB first and reports row counts before promoting |
| `rollback.sh` | Redeploy the previous image tag; warns loudly if the release included a migration, since schema rollback is manual by design |
| `healthcheck.sh` | Cron every 5 min; hits `/health/ready`; alerts the ops channel after 2 consecutive failures |
| `logs.sh` | Tail and filter across services |

`deploy.sh` taking a backup before migrating is not optional — it is the difference between a bad
migration being a ten-minute inconvenience and a catastrophe.

---

## 7. Deploy flow

```
git push  →  GitHub Actions (lint, typecheck, test, build)
          →  ssh deploy@vps 'cd /srv/hixaa && ./infra/scripts/deploy.sh <tag>'
             ├─ backup.sh                    (pre-migration snapshot)
             ├─ docker compose pull
             ├─ docker compose up -d migrate  (waits for completion)
             ├─ docker compose up -d api worker web
             ├─ wait for /health/ready (60 s timeout)
             ├─ success → ops email "deploy ok, tag, duration, migrations applied"
             └─ failure → rollback.sh + ops email "DEPLOY FAILED" + non-zero exit
```

Zero-downtime is achieved with `--scale api=2` and Nginx retrying on `502`, provided the release
contains no breaking migration. Breaking migrations use expand/contract across two releases, so
there is never a moment when running code and current schema disagree.

---

## 8. Backups

| What | Frequency | Retention | Destination |
|---|---|---|---|
| `pg_dump -Fc`, `age`-encrypted | Nightly 01:30 IST + pre-deploy | 7 daily, 4 weekly, 6 monthly | Local `/srv/hixaa/backups` + off-box (rsync/S3) |
| Uploads volume | Weekly incremental | 4 weeks | Off-box |
| Google Sheets | Nightly 02:00 IST | Rolling | Google Drive |
| `.env` (encrypted) | On change | — | Password manager, manual |

**Restore is rehearsed quarterly on staging and the result recorded.** An untested backup is a
hypothesis, not a backup — and the moment you need it is the worst possible time to discover the
dump was empty.

RPO: ≤ 24 h (≤ 1 h if WAL archiving is enabled later). RTO: < 2 h from a clean VPS.

---

## 9. Monitoring

v1 keeps this deliberately small and self-hosted-free: `/health/live` and `/health/ready`; an
external uptime check (UptimeRobot free tier) hitting `/health/ready` every 5 minutes; a cron
healthcheck on the box; Pino JSON logs with `logrotate` at 100 MB / 14 days; queue-depth and
DLQ-size alerts; disk-usage alert at 80%; certificate-expiry alert at 21 days. All alerts route to
the **ops** email channel, never the business one.

Sentry or an OpenTelemetry collector is a natural v2 addition; the logging is already structured
and correlated to make that a drop-in rather than a refactor.

---

## 10. Security hardening on the box

SSH keys only (password auth disabled, root login disabled); `ufw` allowing only 22/80/443;
`fail2ban` on SSH and Nginx auth; unattended security upgrades; Docker daemon not exposed; all
containers non-root with `no-new-privileges`; `.env` root-owned `600`; database and Redis
unreachable from outside the internal network; a dedicated non-root `deploy` user owning `/srv/hixaa`.
