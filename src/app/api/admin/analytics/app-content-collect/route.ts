import { NextRequest, NextResponse } from "next/server";
import { collectAppContentMetrics } from "@/lib/core/app-content-metrics-collect";
import { computeAppContentCollect } from "@/lib/core/app-content-collect-handler";

// 범용(스펙 구동) 앱 컨텐츠 세부 지표 수집 트리거. x-admin-token 보호. 컨텐츠 스펙이
// 등록된 앱을 AppContentMetricDaily 로 집계한다. happy-farm 전용 수집 route
// (/api/admin/analytics/content-collect)와는 별개의 병렬 경로다.
// 토큰 가드/응답 매핑은 computeAppContentCollect(순수, 테스트로 잠금)에 위임한다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const { status, body } = await computeAppContentCollect(
    req.headers.get("x-admin-token"),
    process.env.INTERNAL_ADMIN_TOKEN,
    () => collectAppContentMetrics(new Date()),
  );
  return NextResponse.json(body, { status });
}
