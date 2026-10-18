import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { prisma } from "@/lib/prisma";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { collectExtendedMetrics } from "@/lib/analytics/extended-collect";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;
export async function POST(request: NextRequest) {
  if (!verifyStaticToken(request.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const appId = request.nextUrl.searchParams.get("appId") ?? undefined;
  if (appId && !/^[A-Za-z0-9_-]{1,191}$/.test(appId)) return NextResponse.json({ error: "invalid appId" }, { status: 400 });
  try {
    const revisions = await prisma.configRevision.findMany({ where: { status: "ACTIVE", ...(appId ? { appId } : {}) }, select: { payload: true } });
    const sources = revisions.flatMap((row) => { const parsed = configRevisionPayloadSchema.safeParse(row.payload); return parsed.success ? parsed.data.analyticsSources?.filter((one) => one.enabled) ?? [] : []; });
    if (sources.some((one) => one.source === "admob" && !process.env.ADMOB_REPORTING_OAUTH_JSON || one.source === "play-reports" && !process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON)) return NextResponse.json({ error: "worker_required", remedy: "확장 지표 전용 수집 작업을 실행하세요. 웹에서 수집 실패 원장을 만들지 않았습니다." }, { status: 409 });
    const result = await collectExtendedMetrics(new Date(), appId);
    return NextResponse.json({ ok: true, ...result }, { status: result.results.some((row) => row.status === "failed") ? 207 : 200 });
  } catch { return NextResponse.json({ error: "collection failed" }, { status: 500 }); }
}
