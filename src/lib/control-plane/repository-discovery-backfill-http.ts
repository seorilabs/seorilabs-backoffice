import type { RepositoryDiscoveryBackfillResult } from "@/lib/control-plane/repository-discovery-backfill";
import { verifyStaticToken } from "@/lib/security";
import { scheduledRunHttpStatus } from "@/lib/sync/scheduler-http";

export interface RepositoryDiscoveryBackfillHttpResult {
  status: number;
  body: Record<string, unknown>;
}

export async function computeRepositoryDiscoveryBackfill(
  headerToken: string | null,
  adminToken: string | undefined,
  backfill: () => Promise<RepositoryDiscoveryBackfillResult>,
): Promise<RepositoryDiscoveryBackfillHttpResult> {
  if (!verifyStaticToken(headerToken, adminToken)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  try {
    const result = await backfill();
    return { status: scheduledRunHttpStatus(result), body: { ...result } };
  } catch {
    // GitHub 오류 객체에는 request header가 포함될 수 있어 원문을 노출하지 않는다.
    console.error("[admin/repository-discovery/backfill] 실패 code=BACKFILL_FAILED");
    return { status: 500, body: { error: "repository discovery backfill failed" } };
  }
}
