# Tour 27 Destination Intelligence gateway image (self-hosted). Build from the repo root:
#   docker build -f deploy/tour27/Dockerfile -t tour27-osiris-gateway .
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
# The deployment-mode flag makes the middleware deny everything except the allow-listed Tour 27 routes.
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 OSIRIS_DEPLOYMENT_MODE=tour27-gateway
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
# /api/ready is unauthenticated and reports readiness only (no provider data, no secrets).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/ready >/dev/null || exit 1
CMD ["node", "server.js"]
