# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci

# One-shot administrative tools: direct DB access; never the web runtime role.
# Sync once before migrations to ensure the login exists, then again afterwards
# to reconcile central-auth table grants on fresh and existing volumes.
FROM dependencies AS operations
COPY . .
COPY walkthrough-seed.ts /app/walkthrough-seed.ts
ENV CAIRN_ENV=production
CMD ["sh", "-c", "npm run db:sync-role && npm run db:migrate && npm run db:sync-role && npm run db:init-reference && npm run seed"]

FROM dependencies AS builder
COPY . .
ENV CAIRN_ENV=production
RUN mkdir -p public && npm run build

FROM node:22-bookworm-slim AS app
WORKDIR /app
ENV NODE_ENV=production \
    CAIRN_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN groupadd --system --gid 1001 cairn && useradd --system --uid 1001 --gid cairn cairn
COPY --from=builder --chown=cairn:cairn /app/.next/standalone ./
COPY --from=builder --chown=cairn:cairn /app/.next/static ./.next/static
COPY --from=builder --chown=cairn:cairn /app/public ./public
USER cairn
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

# ── Background worker ────────────────────────────────────────────────────────
# Runs the job queue as its own process, so a ten-minute job cannot hold a web
# request open or make a user wait on a page (CAIRN.md §21).
#
# It needs the TypeScript sources rather than the compiled Next output, because
# the job registry lives in the platform and `tsx` loads it directly. That is
# deliberate: the worker and the web app share one registry, so a job can never
# be enqueued by code that does not know how to run it.
FROM dependencies AS worker
COPY . .
ENV NODE_ENV=production \
    CAIRN_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
RUN groupadd --system --gid 1001 cairn && useradd --system --uid 1001 --gid cairn cairn
USER cairn
CMD ["npm", "run", "worker"]