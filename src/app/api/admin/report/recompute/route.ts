import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { lastElapsedMetricDay, parseMetricDay } from "@/lib/analytics/metric-day";
import { recomputeOrgReports } from "@/lib/core/org-report";

// 과거 스냅샷 소급 재계산. cron 이 아니라 admin 이 직접 부른다.
//
// 2026-08-30~09-11 발행분은 수집이 절반도 오기 전에 찍혀 실제의 1/3.6~1/6 로 남아
// 있다. 그대로 두면 /report 추이선이 영원히 그 값을 그린다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const from = parseMetricDay(req.nextUrl.searchParams.get("from"));
  if (!from) {
    return NextResponse.json({ error: "from 은 YYYY-MM-DD 형식이어야 합니다." }, { status: 400 });
  }
  const rawTo = req.nextUrl.searchParams.get("to");
  const to = rawTo === null ? lastElapsedMetricDay(new Date()) : parseMetricDay(rawTo);
  if (!to) {
    return NextResponse.json({ error: "to 는 YYYY-MM-DD 형식이어야 합니다." }, { status: 400 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await recomputeOrgReports(new Date(), { from, to })) });
  } catch (error) {
    console.error("[admin/report/recompute] 실패:", error);
    const message = error instanceof Error ? error.message : "recompute failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
