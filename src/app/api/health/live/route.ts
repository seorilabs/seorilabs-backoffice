import { NextResponse } from "next/server";

// liveness: 프로세스 생존만 확인 (DB 미접근). ingress 공개 허용.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok" });
}
