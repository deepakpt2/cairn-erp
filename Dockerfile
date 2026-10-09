# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci

# One-shot administrative tools: direct DB access; never the web runtime role.
FROM dependencies AS operations
COPY . .
ENV CAIRN_ENV=production
CMD ["sh", "-c", "npm run db:sync-role && npm run db:migrate && npm run seed && npm run seed:reference"]

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
    CMD node -e "fetch('http://127.0.0.1:3000/signin').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
