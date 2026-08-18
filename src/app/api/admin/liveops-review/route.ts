import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { sendWeeklyLiveopsReview } from "@/lib/notifications/proactive";

// 주간 LiveOps 리뷰 트리거(CronJob 이 호출). x-admin-token 보호.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    await sendWeeklyLiveopsReview();
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[admin/liveops-review] 실패:", e);
    return NextResponse.json({ error: "review failed" }, { status: 500 });
  }
}
