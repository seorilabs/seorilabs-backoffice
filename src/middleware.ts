import NextAuth from "next-auth";
import authConfig from "@/auth.config";

// Edge 미들웨어: 세션 보호. Prisma 미포함 config 사용.
export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // webhook / Discord interaction / auth / admin·control-plane(자체 토큰) /
  // 자체 인증 internal API / health / metrics / 정적 / 로그인 은 보호 제외.
  // 세그먼트 경계((?:/|$))로 앵커 — api/discordX 같은 prefix 우회 방지.
  // 주의: 제외는 공개가 아니다. api/admin/* 는 자체 토큰, operational-events는 timestamp
  // HMAC, api/internal/agents 와 agent-adapter, workflow-bundle-candidate-executor,
  // fleet-migration cleanup capability는 각각 worker/adapter credential 또는 GitHub OIDC와
  // principal/runtime binding으로 route가 fail-closed
  // 인증하며 실패 시 401 JSON을 돌려준다. 반대로 세션 미들웨어가 이들을 가로채면 핸들러에
  // 도달하지 못하고 로그인 HTML(200)이 반환돼 P6 agent queue 경계가 통째로 동작하지 않는다.
  // `api/internal` 을 통째로 제외하지 않는 이유는 새 internal route가 자체 인증 없이
  // 조용히 열리는 것을 막기 위해서다 — 새 경로는 인증을 확인한 뒤 여기에 명시적으로 추가한다.
  // src/middleware.test.ts 가 api/internal/** 전 route를 회귀로 고정한다.
  matcher: [
    "/((?!api/(?:webhooks|discord/interactions|auth|admin|control-plane|health|metrics)(?:/|$)|api/internal/platform/operational-events(?:/|$)|api/internal/fleet-migration/cleanup-capabilities(?:/|$)|api/internal/(?:agents|agent-adapter|workflow-bundle-candidate-executor)(?:/|$)|_next/static|_next/image|favicon.ico|login(?:/|$)).*)",
  ],
};
