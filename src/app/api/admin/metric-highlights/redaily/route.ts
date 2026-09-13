import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { refreshOrgReportSnapshot } from "@/lib/core/org-report";

// Org 종합 보고서 스냅샷 재계산 트리거(CronJob 23:30 KST 이 호출).
// 11:00 KST 발행 후 늦게 도착한 GA4 export / 콘솔 푸시를 반영해 OrgReportDaily 만
// version+1 로 갱신한다.
//
// 발행 경로(runDailyOrgReport)를 쓰지 않는다. 그쪽은 Discord enqueue 까지 하는데,
// 같은 dedupeKey 로 다시 넣으면 아직 보내지 못한 전송이 나중에 이 시점 내용으로 나간다.
// LLM 해설과 비용도 다시 부르게 돼 11:00 발행분과 해설이 갈리고 비용만 든다.
// refreshOrgReportSnapshot 은 수치만 다시 계산하고 발행분의 해설·비용을 그대로 잇는다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await refreshOrgReportSnapshot(new Date())) });
  } catch (error) {
    console.error("[admin/metric-highlights/redaily] 실패:", error);
    return NextResponse.json({ error: "org report redaily failed" }, { status: 500 });
  }
}
