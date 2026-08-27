export type ScheduledRunState = "completed" | "busy" | "partial";

export interface ScheduledRunResult {
  state: ScheduledRunState;
  ok: boolean;
  failed: number;
}

// Kubernetes CronJob은 HTTP 상태로 재시도 여부를 판단한다. busy와 partial을 2xx로
// 숨기지 않아, 실제 작업을 못 한 실행이 성공 이력으로 남지 않게 한다.
export function scheduledRunHttpStatus(result: ScheduledRunResult): number {
  if (result.state === "busy") return 409;
  if (result.state === "partial" || !result.ok || result.failed > 0) return 500;
  return 200;
}
