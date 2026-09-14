import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { parseMetricDay } from "@/lib/analytics/metric-day";
import { reconcileOrgReport } from "@/lib/core/org-report";

// 발행분 정정 트리거(야간 발행 cron 이 D-1 발행 직후 이어서 호출).
//
// 발행은 D-1 을 내보내지만 그 시점에 늦게 도착한 export 가 있을 수 있다. 하루 뒤
// 같은 날짜를 다시 계산해 사실이 달라졌으면 같은 Discord 메시지를 고친다. 사실이
// 같으면 아무것도 하지 않는다 — 변화 없는 version+1 은 감사 기록을 흐린다.
//
// day query 로 특정 날짜를 지정할 수 있다(과거 발행분 소급 정정).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const raw = req.nextUrl.searchParams.get("day");
  if (raw !== null && parseMetricDay(raw) === null) {
    return NextResponse.json({ error: "day 는 YYYY-MM-DD 형식이어야 합니다." }, { status: 400 });
  }
  try {
    const day = parseMetricDay(raw);
    const result = await reconcileOrgReport(new Date(), day ? { day } : {});
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[admin/metric-highlights/reconcile] 실패:", error);
    return NextResponse.json({ error: "org report reconcile failed" }, { status: 500 });
  }
}
