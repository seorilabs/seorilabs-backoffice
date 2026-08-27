import { verifyStaticToken } from "@/lib/security";
import {
  scheduledRunHttpStatus,
  type ScheduledRunResult,
} from "@/lib/sync/scheduler-http";

export interface ReconcileHttpResult {
  status: number;
  body: Record<string, unknown>;
}

export interface ReconcileResult extends ScheduledRunResult {
  repos: number;
  succeeded: number;
}

// Kubernetes CronJob이 호출하는 reconcile HTTP 경계. 인증 실패에서는 작업을
// 시작하지 않고, 내부 오류 원문은 응답으로 노출하지 않는다.
export async function computeReconcile(
  headerToken: string | null,
  adminToken: string | undefined,
  reconcile: () => Promise<ReconcileResult>,
): Promise<ReconcileHttpResult> {
  if (!verifyStaticToken(headerToken, adminToken)) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  try {
    const result = await reconcile();
    return { status: scheduledRunHttpStatus(result), body: { ...result } };
  } catch (error) {
    console.error("[admin/reconcile] 실패:", error);
    return { status: 500, body: { error: "reconcile failed" } };
  }
}
