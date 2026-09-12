import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { runDailyOrgReport } from "@/lib/core/org-report";

// Org 종합 보고서 스냅샷 재계산 트리거(CronJob 23:30 KST 이 호출).
// 11:00 KST 발행 후 늦게 도착한 GA4 export / 콘솔 푸시를 반영해 OrgReportDaily 만
// version+1 로 갱신한다. Discord 발송은 dedupeKey(`metric-highlight:<refDate>`)가
// 하루 1건이라 두 번째 enqueue 는 notification_event 의 payload 만 덮어쓰고
// 실제 발송은 무시된다 — 사용자에게는 11:00 KST 메시지 한 번만 도달.
//
// 목적: 다음 날 아침 /report 페이지가 최신 raw 데이터를 본 스냅샷을 보여주도록
// 보장. Discord 메시지를 다시 보내는 게 아니므로 metric-highlights 메시지 본문
// 변경도 일어나지 않는다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await runDailyOrgReport(new Date())) });
  } catch (error) {
    console.error("[admin/metric-highlights/redaily] 실패:", error);
    return NextResponse.json({ error: "org report redaily failed" }, { status: 500 });
  }
}
