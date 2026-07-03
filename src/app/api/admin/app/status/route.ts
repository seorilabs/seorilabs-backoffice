import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { setAppStatusCore, isAppStatus } from "@/lib/core/app-status";

// 앱 운영 상태 변경. body { app(slug|id), status }. x-admin-token 보호.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { app?: string; status?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty */
  }
  const app = (body.app ?? "").trim();
  const status = (body.status ?? "").trim().toUpperCase();
  if (!app || !isAppStatus(status)) {
    return NextResponse.json(
      { error: "app, status(ACTIVE|PAUSED) 필요" },
      { status: 400 },
    );
  }
  try {
    const r = await setAppStatusCore({ idOrSlug: app, status, actorLogin: "admin" });
    if (!r) return NextResponse.json({ ok: false, error: "앱 없음" }, { status: 404 });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 409 });
  }
}
