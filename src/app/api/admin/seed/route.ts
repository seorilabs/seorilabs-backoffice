import { NextRequest, NextResponse } from "next/server";
import { seedRegistry } from "@/lib/seed/registry";
import { verifyStaticToken } from "@/lib/security";

// 헤드리스 배포용 시드 트리거. x-admin-token 으로 보호(세션 아님, 상수시간 비교).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await seedRegistry({ backfill: true });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[admin/seed] 실패:", err);
    return NextResponse.json({ error: "seed failed" }, { status: 500 });
  }
}
