import type { ReleaseStatus } from "@prisma/client";
import { parseStableSemVerTag } from "@/lib/core/stable-semver";
import { parseSnapshotCandidateTag } from "@/lib/core/snapshot-candidate";

export function releaseStatusOf(
  status?: string | null,
  conclusion?: string | null,
): ReleaseStatus {
  if (status !== "completed") return "IN_PROGRESS";
  if (conclusion === "success") return "SUCCEEDED";
  // 취소·시간초과·startup_failure 등 모든 비성공 완료는 재시도 가능한 실패로 수렴한다.
  return "FAILED";
}

/** snapshot 후보·untagged 빌드는 배포 기록만 남기고 정식 출시 단계는 전이하지 않는다. */
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
  return parseSnapshotCandidateTag(input.version) ? "internal" : null;
}

/**
 * 표준 배포 artifact 이름에서 유일한 stable 릴리스 태그를 복원한다.
 * 서로 다른 태그가 섞였거나 prerelease 표기면 추측하지 않고 null을 반환한다.
 */
export function stableReleaseTagFromArtifactNames(names: string[]): string | null {
  const tags = new Set<string>();
  for (const name of names) {
    const matches = name.matchAll(
      /(?:^|[-_.])(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?=$|[-_.])/gu,
    );
    for (const match of matches) {
      const tag = match[1];
      const tail = name.slice((match.index ?? 0) + match[0].length);
      if (/^-(?:alpha|beta|pre|rc|snapshot)(?:$|[-_.\d])/iu.test(tail)) continue;
      if (parseStableSemVerTag(tag)) tags.add(tag);
    }
  }
  return tags.size === 1 ? [...tags][0] : null;
}
