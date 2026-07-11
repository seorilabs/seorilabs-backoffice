import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { collectContentMetrics } from "@/lib/core/content-metrics-collect";

// happy-farm 콘텐츠 세부 지표 수집 트리거(CronJob 이 호출). x-admin-token 보호.
// 공통 지표 수집(analytics/collect) 이후에 돌려 GA4 export 착지분을 함께 집계한다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await collectContentMetrics(new Date());
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[admin/analytics/content-collect] 실패:", e);
    return NextResponse.json({ error: "content collect failed" }, { status: 500 });
  }
}
