import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { checkGodotVersion } from "@/lib/godot/version-check";

// Godot 최신 stable 감지 트리거(CronJob 이 호출). x-admin-token 보호.
// pin 버전보다 새 stable 이 나오면 Discord 알림. 코드 수정은 하지 않음.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await checkGodotVersion();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[admin/godot-version-check] 실패:", e);
    return NextResponse.json({ error: "godot version check failed" }, { status: 500 });
  }
}
