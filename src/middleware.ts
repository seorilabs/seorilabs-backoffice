import NextAuth from "next-auth";
import authConfig from "@/auth.config";

// Edge 미들웨어: 세션 보호. Prisma 미포함 config 사용.
export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // webhook / telegram / auth / admin(토큰) / health / metrics / 정적 / 로그인 은 보호 제외.
  // 세그먼트 경계((?:/|$))로 앵커 — api/telegramX 같은 prefix 우회 방지.
  // 주의: api/admin/* 는 세션 미들웨어에서 제외되므로 각 admin 라우트는 자체 토큰 인증 필수.
  matcher: [
    "/((?!api/(?:webhooks|telegram|auth|admin|health|metrics)(?:/|$)|_next/static|_next/image|favicon.ico|login(?:/|$)).*)",
  ],
};
