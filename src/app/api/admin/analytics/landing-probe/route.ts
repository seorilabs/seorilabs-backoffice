import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { probeLandings } from "@/lib/core/metric-landing-probe";

// GA4 export 착지 시각 실측(CronJob 2시간 간격). 지표는 수집하지 않고, 아직 착지하지
// 않은 칸이 남은 앱에만 메타데이터를 물어 landedAt 을 남긴다.
//
// 발행 시각을 근거로 정하기 위한 장치다. 지금은 D-1 이 언제쯤 다 오는지 아무도 모른다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await probeLandings(new Date());
    // 조회한 앱이 전부 실패했으면 성공이 아니다. 볼 것이 없었던 경우(probedApps=0)와
    // 구분해야 "조용히 아무것도 안 하는 프로브"가 되지 않는다.
    if (result.probedApps > 0 && result.errors.length === result.probedApps) {
      console.error("[admin/analytics/landing-probe] 전 대상 조회 실패:", result.errors);
      return NextResponse.json({ ok: false, ...result }, { status: 500 });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[admin/analytics/landing-probe] 실패:", e);
    return NextResponse.json({ error: "landing probe failed" }, { status: 500 });
  }
}
