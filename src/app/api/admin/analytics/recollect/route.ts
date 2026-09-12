import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { collectMetrics } from "@/lib/core/analytics-collect";

// 일별 GA4 지표 재집계 트리거(CronJob 23:00 KST 이 호출). Discord 발송이나
// 종합 보고서 발행은 하지 않고 AppMetricDaily 만 갱신한다. 11:00 KST 발행분은
// dedupeKey 가 하루 1건이라 재실행해도 무해하지만, Obsidian 큐잉은 매 호출마다
// 새 노트가 쌓이므로 metric-daily 보고에는 절대 연결하지 않는다.
//
// windowDays 를 query 로 덮어쓸 수 있지만 운영상 기본값(현재 WINDOW_DAYS) 사용이
// 안전하다. 강제 백필이 필요할 때만 admin 이 windowDays 를 지정한다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await collectMetrics(new Date());
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[admin/analytics/recollect] 실패:", e);
    return NextResponse.json({ error: "recollect failed" }, { status: 500 });
  }
}
