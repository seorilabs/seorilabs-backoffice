import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { collectPlatformUserMetrics } from "@/lib/core/platform-metric-collect";

// 플랫폼 사용자 규모 시점 스냅샷(CronJob 매시 정각이 호출). x-admin-token 보호.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await collectPlatformUserMetrics(new Date());
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // 백필이 불가능하므로 실패를 성공으로 위장하지 않는다. CronJob이
    // 실패로 끝나야 재시도가 걸리고, 그래도 놓치면 그 시각은 영구히 빈다.
    console.error("[admin/platform/metrics-collect] 실패:", e);
    return NextResponse.json({ error: "collect failed" }, { status: 500 });
  }
}
