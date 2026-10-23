import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import {
  getConsoleSyncStatus,
} from "@/lib/core/console-metrics-collect";
import { ingestAndVerifyConsolePush } from "@/lib/analytics/console-sync/push";

// AppsInToss 콘솔 지표 ingest(push). 인증된 로컬 Claude 세션(스케줄러)이 MCP dashboard_* 를
// 조회·정규화해 { apps: ConsoleAppPush[] } 를 POST 한다. x-admin-token 보호(GA4 collect 와 동일).
// 승인된 OAuth 파드 pull 수집기와 별도로 기존 인증된 push 경로를 유지한다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET: 수집 대상 앱별 마지막 동기화 상태(last date/collectedAt/rows). 온디맨드 수집 커맨드가
// "어디부터 당길지" 증분 윈도우를 정하려고 읽는다. POST(ingest)와 동일 token 으로 보호.
export async function GET(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const status = await getConsoleSyncStatus();
    return NextResponse.json({ ok: true, ...status });
  } catch (e) {
    console.error("[admin/analytics/console-collect] status 실패:", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  try {
    const result = await ingestAndVerifyConsolePush(payload, new Date());
    return NextResponse.json({ ok: true, ...result });
  } catch {
    return NextResponse.json({ error: "console collection or verification failed" }, { status: 500 });
  }
}
