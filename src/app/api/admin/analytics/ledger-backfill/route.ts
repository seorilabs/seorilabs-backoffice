import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { parseWindowDays } from "@/lib/ga4/datasets";
import { backfillMetricLedger } from "@/lib/core/metric-ledger-backfill";

// 수집 원장이 생기기 전 기간을 지금 알 수 있는 사실로 채운다. cron 이 아니라
// admin 이 직접 한 번 부른다. 과거를 추측하지 않으므로 몇 번을 돌려도 같은 답이다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_WINDOW_DAYS = 30;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let windowDays: number;
  try {
    windowDays = parseWindowDays(req.nextUrl.searchParams.get("days")) ?? DEFAULT_WINDOW_DAYS;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const result = await backfillMetricLedger(new Date(), { windowDays });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[admin/analytics/ledger-backfill] 실패:", e);
    return NextResponse.json({ error: "ledger backfill failed" }, { status: 500 });
  }
}
