# syntax=docker/dockerfile:1
# ARM64 (vzyx-cluster) Next.js standalone + Prisma.

FROM node:24.16.0-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# ── deps: 캐시 가능한 의존성 설치 (prisma generate postinstall 위해 schema 포함) ──
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

# ── build: next build (standalone) + prisma generate ──
FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="mysql://build:build@127.0.0.1:3306/build"
RUN pnpm prisma generate && pnpm build

# ── runtime: 슬림 standalone + prisma migrate(deploy) 가능 ──
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN groupadd --system --gid 10001 app \
  && useradd --system --uid 10001 --gid 10001 app

# 앱 런타임: standalone 이 @prisma/client + linux-arm64 query engine 까지 포함(self-contained).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# migrate deploy 용: schema/migrations + prisma CLI(글로벌, schema-engine 포함).
COPY --from=build /app/prisma ./prisma
RUN npm install -g prisma@6.19.3

USER 10001
EXPOSE 3000
CMD ["node", "server.js"]
