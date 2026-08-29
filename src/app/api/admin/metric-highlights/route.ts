import { NextRequest, NextResponse } from "next/server";
import { sendMetricHighlightReport } from "@/lib/core/metric-highlights";
import { verifyStaticToken } from "@/lib/security";

// 서리 일일 지표 하이라이트·로우라이트 트리거(CronJob 이 호출). 저장된 GA4·콘솔
// 스냅샷만 읽어 알림 outbox 에 넣고, 전달은 notification worker 가 한다.
// dedupeKey(기준일) unique 라 CronJob 중복 발화는 무해하다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  if (!verifyStaticToken(request.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await sendMetricHighlightReport(new Date())) });
  } catch (error) {
    console.error("[admin/metric-highlights] 실패:", error);
    return NextResponse.json({ error: "metric highlight report failed" }, { status: 500 });
  }
}
