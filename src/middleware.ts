import NextAuth from "next-auth";
import authConfig from "@/auth.config";

// Edge 미들웨어: 세션 보호. Prisma 미포함 config 사용.
export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // webhook / auth / admin(토큰) / health / metrics / 정적 / 로그인 은 보호 제외.
  matcher: [
    "/((?!api/webhooks|api/auth|api/admin|api/health|api/metrics|_next/static|_next/image|favicon.ico|login).*)",
  ],
};
