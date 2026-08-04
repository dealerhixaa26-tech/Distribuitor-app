# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Hixaa DMS — API and worker image.
#
# One image, two entrypoints (`main.js` / `worker.js`). Sharing the image means
# the API and the worker can never drift out of sync — they are literally the
# same build.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:24-alpine AS base
RUN corepack enable && apk add --no-cache dumb-init
WORKDIR /app
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH


# ── Dependencies ────────────────────────────────────────────────────────────
# Only manifests are copied first, so this layer is cached across every source
# change — the difference between a 20-second and a 4-minute rebuild.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/config/package.json packages/config/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile


# ── Build ───────────────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY . .

RUN pnpm --filter @hixaa/contracts build \
 && pnpm --filter @hixaa/api exec prisma generate \
 && pnpm --filter @hixaa/api build

# Drop dev dependencies, then regenerate the Prisma client — pruning removes the
# generated client along with the `prisma` CLI that produced it.
RUN pnpm prune --prod --no-optional \
 && pnpm --filter @hixaa/api exec prisma generate


# ── Runtime ─────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
ENV TZ=Asia/Kolkata

# Never root. A container escape should not land on a privileged account.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nodejs -G nodejs

COPY --from=build --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nodejs:nodejs /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=nodejs:nodejs /app/packages/contracts/package.json ./packages/contracts/
COPY --from=build --chown=nodejs:nodejs /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=nodejs:nodejs /app/apps/api/dist ./apps/api/dist
# Schema and migrations ship (the migrate service needs them). prisma.config.ts
# deliberately does NOT — it is TypeScript and would require a loader at
# runtime. The migrate command passes --schema explicitly instead.
COPY --from=build --chown=nodejs:nodejs /app/apps/api/prisma ./apps/api/prisma
COPY --from=build --chown=nodejs:nodejs /app/apps/api/package.json ./apps/api/

# Uploads live on a mounted volume; the directory must exist and be writable.
RUN mkdir -p /var/hixaa/uploads && chown -R nodejs:nodejs /var/hixaa

WORKDIR /app/apps/api
USER nodejs
EXPOSE 4000

# Probes /live, not /ready: a brief database blip must not cause Docker to kill
# an otherwise healthy process. See docs/10-deployment.md §1.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# dumb-init reaps zombies and forwards SIGTERM, so graceful shutdown works.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
