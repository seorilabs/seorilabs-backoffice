import type { ReleaseStatus } from "@prisma/client";

export function releaseStatusOf(
  status?: string | null,
  conclusion?: string | null,
): ReleaseStatus {
  if (status !== "completed") return "IN_PROGRESS";
  if (conclusion === "success") return "SUCCEEDED";
  // 취소·시간초과·startup_failure 등 모든 비성공 완료는 재시도 가능한 실패로 수렴한다.
  return "FAILED";
}
