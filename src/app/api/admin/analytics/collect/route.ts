import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { collectMetrics } from "@/lib/core/analytics-collect";
import { parseWindowDays } from "@/lib/ga4/datasets";

// GA4 지표 수집 트리거(CronJob 21:00 KST 이 호출). x-admin-token 보호.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let windowDays: number | undefined;
  try {
    windowDays = parseWindowDays(req.nextUrl.searchParams.get("windowDays"));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const result = await collectMetrics(new Date(), { windowDays });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[admin/analytics/collect] 실패:", e);
    return NextResponse.json({ error: "collect failed" }, { status: 500 });
  }
}
