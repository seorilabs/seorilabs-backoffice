import { NextRequest, NextResponse } from "next/server";
import { sendFinanceReport } from "@/lib/core/finance-report";
import { verifyStaticToken } from "@/lib/security";

// 서리 일일 재무 리포트 트리거(CronJob 이 호출). 비용 4소스를 여기서 모아 알림
// outbox 에 넣고, 전달은 notification worker 가 한다. dedupeKey(KST 날짜) unique 라
// CronJob 중복 발화는 무해하다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  if (!verifyStaticToken(request.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await sendFinanceReport(new Date())) });
  } catch (error) {
    console.error("[admin/finance-report] 실패:", error);
    return NextResponse.json({ error: "finance report failed" }, { status: 500 });
  }
}
