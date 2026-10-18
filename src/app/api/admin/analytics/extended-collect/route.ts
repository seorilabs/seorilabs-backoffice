import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { collectExtendedMetrics } from "@/lib/analytics/extended-collect";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;
export async function POST(request: NextRequest) {
  if (!verifyStaticToken(request.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const appId = request.nextUrl.searchParams.get("appId") ?? undefined;
  if (appId && !/^[A-Za-z0-9_-]{1,191}$/.test(appId)) return NextResponse.json({ error: "invalid appId" }, { status: 400 });
  try {
    const result = await collectExtendedMetrics(new Date(), appId);
    return NextResponse.json({ ok: true, ...result }, { status: result.results.some((row) => row.status === "failed") ? 207 : 200 });
  } catch { return NextResponse.json({ error: "collection failed" }, { status: 500 }); }
}
