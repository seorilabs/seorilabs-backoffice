import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { ga4CoverageTargets } from "@/lib/analytics/targets";
import { lastElapsedMetricDay, metricDayWindow, toGa4TableSuffix } from "@/lib/analytics/metric-day";
import { queryMatgoCohorts } from "@/lib/ga4/matgo-cohorts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** 운영 설정과 원시 저장을 바꾸지 않고 기존 활성 GA4 연결만 조회한다. */
export async function GET(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const days = req.nextUrl.searchParams.get("days") ?? "14";
  if (days !== "7" && days !== "14") return NextResponse.json({ error: "days는 7 또는 14입니다." }, { status: 400 });
  try {
    const { targets } = await ga4CoverageTargets();
    const target = targets.find(item => item.slug === "matgo");
    if (!target) return NextResponse.json({ status: "unavailable", reason: "analytics_connection_not_configured", cohorts: [] }, { status: 503 });
    const end = lastElapsedMetricDay(new Date());
    return NextResponse.json(await queryMatgoCohorts(target.ga4,
      toGa4TableSuffix(metricDayWindow(end, Number(days))[0]), toGa4TableSuffix(end)));
  } catch (error) {
    console.error("[admin/analytics/matgo-cohorts] 조회 실패:", error);
    return NextResponse.json({ status: "unavailable", reason: "daily_export_or_reader_unavailable", cohorts: [] }, { status: 503 });
  }
}
