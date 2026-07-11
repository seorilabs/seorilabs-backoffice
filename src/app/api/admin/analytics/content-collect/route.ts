import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { collectContentMetrics } from "@/lib/core/content-metrics-collect";
import { collectFoamContentMetrics } from "@/lib/core/foam-content-collect";

// 콘텐츠 세부 지표 수집 트리거(CronJob 이 호출). x-admin-token 보호.
// 공통 지표 수집(analytics/collect) 이후에 돌려 GA4 export 착지분을 함께 집계한다.
// 앱별 콘텐츠 수집기를 모두 실행한다(happy-farm: 작물/구역/기능퍼널/광고,
// foam-party: 레벨/수익화/미션/경제). 한 쪽 실패가 다른 쪽 결과를 삼키지 않도록 분리.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const now = new Date();
  const happyFarm = await settle(() => collectContentMetrics(now));
  const foamParty = await settle(() => collectFoamContentMetrics(now));
  const ok = !("error" in happyFarm) || !("error" in foamParty);
  return NextResponse.json({ ok, happyFarm, foamParty });
}

// 각 수집기를 독립적으로 실행. 실패는 { error } 로 캡처(전체 500 대신 부분 결과 반환).
async function settle<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    console.error("[admin/analytics/content-collect] 수집 실패:", e);
    return { error: (e as Error).message.slice(0, 300) };
  }
}
