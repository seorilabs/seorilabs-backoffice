import { NextRequest, NextResponse } from "next/server";
import { prepareDailyReport } from "@/lib/report/daily-publication";
import { parseMetricDay } from "@/lib/analytics/metric-day";
import { verifyStaticToken } from "@/lib/security";

// 10:45 KST 입력·대상·설정·그래프 동결. 같은 날짜 재호출은 준비본을 유지한다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 종량제 비용 4소스(각 15s timeout) + LLM 해설이 얹히므로 여유를 둔다.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!verifyStaticToken(request.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const raw = request.nextUrl.searchParams.get("day");
  const day = parseMetricDay(raw);
  if (raw !== null && !day) return NextResponse.json({ error: "valid day required" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...(await prepareDailyReport(new Date(), day ?? undefined)) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("REPORT_BEFORE")) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error("[admin/metric-highlights] 실패:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "metric highlight report failed" }, { status: 500 });
  }
}
