import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { sendDailyDigest } from "@/lib/telegram/nudges";

// 데일리 다이제스트 트리거(CronJob 이 호출). x-admin-token 보호.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    await sendDailyDigest(new Date());
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[admin/digest] 실패:", e);
    return NextResponse.json({ error: "digest failed" }, { status: 500 });
  }
}
