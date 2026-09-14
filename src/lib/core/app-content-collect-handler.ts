import { verifyStaticToken } from "@/lib/security";
import type { ContentCollectResult } from "@/lib/core/app-content-metrics-collect";
import { collectionFailedEntirely } from "@/lib/core/analytics-collect";

// app-content-collect 라우트의 순수 핸들러(next/server 비의존). 토큰 가드 → collect →
// 응답 매핑을 plain 객체({status, body})로 반환해 회귀 테스트로 잠근다. 라우트는 이
// 결과를 NextResponse 로 감싸기만 한다.

export interface CollectHttpResult {
  status: number;
  body: Record<string, unknown>;
}

export async function computeAppContentCollect(
  headerToken: string | null,
  adminToken: string | undefined,
  collect: () => Promise<ContentCollectResult>,
): Promise<CollectHttpResult> {
  if (!verifyStaticToken(headerToken, adminToken)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  try {
    const result = await collect();
    // 전 대상 실패는 성공이 아니다. cron 의 curl -fsS 가 잡게 500 으로 낸다.
    if (collectionFailedEntirely(result)) {
      console.error("[admin/analytics/app-content-collect] 전 대상 수집 실패:", result.errors);
      return { status: 500, body: { ok: false, ...result } };
    }
    return { status: 200, body: { ok: true, ...result } };
  } catch (e) {
    console.error("[admin/analytics/app-content-collect] 실패:", e);
    return { status: 500, body: { error: "app content collect failed" } };
  }
}
