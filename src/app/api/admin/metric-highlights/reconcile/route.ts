import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { parseMetricDay } from "@/lib/analytics/metric-day";
import { correctDailyReport, correctRecentDailyReports } from "@/lib/report/daily-publication";

// 공급자의 3~7일 지연을 포함해 최근 8일의 실제 발행본을 정정한다.
// day를 지정하면 해당 날짜만 기존 응답 계약으로 재처리한다.
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
    const now = new Date();
    const result = day ? await correctDailyReport(now, day) : await correctRecentDailyReports(now);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[admin/metric-highlights/reconcile] 실패:", error);
    return NextResponse.json({ error: "org report reconcile failed" }, { status: 500 });
  }
}
