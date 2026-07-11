import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { collectMetrics } from "@/lib/core/analytics-collect";
import { collectContentMetrics } from "@/lib/core/content-collect";

// GA4 지표 수집 트리거(CronJob 21:00 KST 이 호출). x-admin-token 보호.
// 공통 지표(AppMetricDaily) + 콘텐츠 세부 지표(레벨/수익화/미션/경제)를 함께 수집한다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const now = new Date();
    const common = await collectMetrics(now);
    // 콘텐츠 수집 실패가 공통 지표 결과까지 삼키지 않도록 분리 처리.
    let content: Awaited<ReturnType<typeof collectContentMetrics>> | { error: string };
    try {
      content = await collectContentMetrics(now);
    } catch (e) {
      console.error("[admin/analytics/collect] 콘텐츠 수집 실패:", e);
      content = { error: (e as Error).message.slice(0, 300) };
    }
    return NextResponse.json({ ok: true, common, content });
  } catch (e) {
    console.error("[admin/analytics/collect] 실패:", e);
    return NextResponse.json({ error: "collect failed" }, { status: 500 });
  }
}
