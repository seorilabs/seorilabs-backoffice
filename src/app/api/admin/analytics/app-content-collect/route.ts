import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { collectAppContentMetrics } from "@/lib/core/app-content-metrics-collect";

// 범용(스펙 구동) 앱 컨텐츠 세부 지표 수집 트리거. x-admin-token 보호. 컨텐츠 스펙이
// 등록된 앱을 AppContentMetricDaily 로 집계한다. happy-farm 전용 수집 route
// (/api/admin/analytics/content-collect)와는 별개의 병렬 경로다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await collectAppContentMetrics(new Date());
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[admin/analytics/app-content-collect] 실패:", e);
    return NextResponse.json({ error: "app content collect failed" }, { status: 500 });
  }
}
