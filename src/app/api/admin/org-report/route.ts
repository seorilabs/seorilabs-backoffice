import { NextRequest, NextResponse } from "next/server";
import { buildOrgReportForDate } from "@/lib/core/org-report";
import { verifyStaticToken } from "@/lib/security";

// Org 종합 보고서 수동 재발행/백필. 지정한 날짜를 원본 테이블에서 재계산해 스냅샷으로
// 저장한다(version+1). 늦게 도착한 콘솔 push 반영이나 과거 날짜 소급 발행에 쓴다.
// Discord 발송은 하지 않는다 — 발송은 일일 cron(metric-highlights) 경로뿐이다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: NextRequest) {
  if (!verifyStaticToken(request.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const date = request.nextUrl.searchParams.get("date");
  if (!date || !DATE_RE.test(date)) {
    return NextResponse.json({ error: "date=YYYY-MM-DD 가 필요합니다." }, { status: 400 });
  }
  try {
    const built = await buildOrgReportForDate(date, { persist: true });
    if (!built) {
      return NextResponse.json(
        { error: `해당 날짜의 GA4·콘솔 데이터가 없습니다: ${date}` },
        { status: 404 },
      );
    }
    return NextResponse.json({
      ok: true,
      refDate: built.doc.refDate,
      version: built.version,
      origin: built.doc.origin,
      consoleLagDays: built.doc.consoleMeta.lagDays,
    });
  } catch (error) {
    console.error("[admin/org-report] 실패:", error);
    return NextResponse.json({ error: "org report rebuild failed" }, { status: 500 });
  }
}
