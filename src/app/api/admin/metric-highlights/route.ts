import { NextRequest, NextResponse } from "next/server";
import { runDailyOrgReport } from "@/lib/core/org-report";
import { verifyStaticToken } from "@/lib/security";

// 서리 일일 지표 하이라이트 + Org 종합 보고서 발행 트리거(CronJob 이 호출).
// 저장된 GA4·콘솔 스냅샷으로 판정하고, 같은 계산 결과를 (1) OrgReportDaily 스냅샷으로
// 저장한 뒤 (2) 하이라이트 리포트를 알림 outbox 에 넣는다(전달은 notification worker).
// dedupeKey(기준일) unique 라 CronJob 중복 발화는 무해하다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 종량제 비용 4소스(각 15s timeout) + LLM 해설이 얹히므로 여유를 둔다.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!verifyStaticToken(request.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await runDailyOrgReport(new Date())) });
  } catch (error) {
    console.error("[admin/metric-highlights] 실패:", error);
    return NextResponse.json({ error: "metric highlight report failed" }, { status: 500 });
  }
}
