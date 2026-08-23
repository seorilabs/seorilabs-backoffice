import type { ReleaseStatus } from "@prisma/client";
import { parseStableSemVerTag } from "@/lib/core/stable-semver";
import { parseDevelopCandidateTag } from "@/lib/core/develop-candidate";

export function releaseStatusOf(
  status?: string | null,
  conclusion?: string | null,
): ReleaseStatus {
  if (status !== "completed") return "IN_PROGRESS";
  if (conclusion === "success") return "SUCCEEDED";
  // 취소·시간초과·startup_failure 등 모든 비성공 완료는 재시도 가능한 실패로 수렴한다.
  return "FAILED";
}

/** develop 후보·untagged 빌드는 배포 기록만 남기고 정식 출시 단계는 전이하지 않는다. */
export function shouldAdvanceLifecycleForRelease(
  status: ReleaseStatus,
  version: string,
): boolean {
  return status === "SUCCEEDED" && parseStableSemVerTag(version) !== null;
}

export function releaseTrackForWorkflow(input: {
  market: string;
  promoted: boolean;
  version: string;
}): string | null {
  if (input.market !== "PLAY") return null;
  if (input.promoted) return "production";
  return parseDevelopCandidateTag(input.version) ? "internal" : null;
}
