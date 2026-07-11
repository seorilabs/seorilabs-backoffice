import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { collectContentMetrics } from "@/lib/core/content-metrics-collect";

// 앱 컨텐츠 세부 지표 수집 트리거(CronJob 이 공통 지표 collect 직후 호출). x-admin-token
// 보호. 공통 지표(AppMetricDaily) 수집과 독립적으로 실패해도 서로 영향 없도록 별도 route.
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
