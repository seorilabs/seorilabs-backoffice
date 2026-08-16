import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { sendMetricsReport } from "@/lib/core/analytics-report";

// 일별 지표 보고서 트리거(CronJob 10:30 KST 이 호출). GA4 + AppsInToss 콘솔 요약을 함께 발송.
// x-admin-token 보호.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await sendMetricsReport(new Date());
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[admin/analytics/report] 실패:", e);
    return NextResponse.json({ error: "report failed" }, { status: 500 });
  }
}
