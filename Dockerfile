# syntax=docker/dockerfile:1
# ARM64 (vzyx-cluster) Next.js standalone + Prisma.
#
# 크로스빌드: 의존성 설치와 next build 는 BUILDPLATFORM(GitHub-hosted 러너의 네이티브
# 아키텍처)에서 돌고, 런타임 스테이지만 TARGETPLATFORM(arm64)이다. 무거운 JS 빌드에
# QEMU 가 개입하지 않는다. 산출물이 아키텍처와 무관한 근거는 세 가지다.
#   - Next standalone 산출물은 순수 JS 다.
#   - Prisma arm64 query engine 은 schema.prisma 의 binaryTargets 로 명시 생성된다.
#   - sharp(Next 의 optional 전이 의존)는 next.config.ts 의 outputFileTracingExcludes
#     로 트레이스에서 제외했다. 제외하지 않으면 빌드 호스트 아키텍처의 바이너리가
#     arm64 이미지에 딸려 들어간다.
# 런타임 스테이지의 RUN(apt, useradd, prisma CLI 설치)만 QEMU 로 에뮬레이션된다.

# ── build-base: 빌드 호스트 네이티브 아키텍처 ──
FROM --platform=$BUILDPLATFORM node:24.16.0-bookworm-slim AS build-base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# ── deps: 캐시 가능한 의존성 설치 (prisma generate postinstall 위해 schema 포함) ──
FROM build-base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
# pnpm store 를 캐시 마운트에 두어 재다운로드 회피.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir=/pnpm/store

# ── build: next build (standalone) + prisma generate ──
FROM build-base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="mysql://build:build@127.0.0.1:3306/build"
# 증분 빌드 시 .next/cache 로드 + webpack 으로 메모리 피크가 커져 OOM 가능 →
# node 힙 상한으로 피크 억제.
ENV NODE_OPTIONS=--max-old-space-size=2048
RUN --mount=type=cache,id=next-cache,target=/app/.next/cache \
  pnpm prisma generate \
  && pnpm build \
  && sh scripts/prune-standalone-prisma-engines.sh .next/standalone
# data ns CronJob 용 인덱서/라이터 엔트리를 단일 CJS 로 번들(@prisma/client 는 external).
RUN pnpm build:scripts

# ── runtime: TARGETPLATFORM(arm64) 슬림 standalone + prisma migrate(deploy) 가능 ──
FROM node:24.16.0-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
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
# data ns CronJob(인덱서/라이터) 엔트리. standalone node_modules 의 @prisma/client 를 재사용.
COPY --from=build /app/scripts-dist ./scripts-dist
# migrate deploy 용: schema/migrations + prisma CLI(글로벌, schema-engine 포함).
COPY --from=build /app/prisma ./prisma
RUN --mount=type=cache,id=npm-global,target=/root/.npm \
  npm install -g prisma@6.19.3

USER 10001
EXPOSE 3000
CMD ["node", "server.js"]
