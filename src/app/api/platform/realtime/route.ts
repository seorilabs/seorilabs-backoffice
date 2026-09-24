import { NextResponse } from "next/server";

import { loadGa4RealtimeSnapshot } from "@/lib/ga4/realtime";

export const dynamic = "force-dynamic";

// 설정 누락처럼 전체 조회가 불가능할 때만 503이다. 앱별 권한 오류는
// 200 응답 안에서 해당 앱만 실패로 표시한다.
export async function GET() {
  try {
    return NextResponse.json({ ok: true, snapshot: await loadGa4RealtimeSnapshot() });
  } catch {
    return NextResponse.json(
      { ok: false, error: "GA4 실시간 집계를 읽지 못했습니다." },
      { status: 503 },
    );
  }
}
