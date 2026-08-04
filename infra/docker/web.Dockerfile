# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Hixaa DMS — Admin Portal (Next.js standalone).
# ─────────────────────────────────────────────────────────────────────────────

FROM node:24-alpine AS base
RUN corepack enable && apk add --no-cache dumb-init
WORKDIR /app
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH


FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/config/package.json packages/config/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile


FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY . .
RUN pnpm --filter @hixaa/contracts build \
 && pnpm --filter @hixaa/web build


FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV TZ=Asia/Kolkata
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# `output: standalone` emits a self-contained server with only the modules the
# app actually imports — the full workspace node_modules is an order of
# magnitude larger.
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/dashboard').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/web/server.js"]
