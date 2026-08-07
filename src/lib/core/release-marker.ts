// 릴리즈 경계 마커 커밋 규약(순수 모듈 — github/core 양쪽에서 import).
//
// GitHub 의 /commits 화면은 태그도 배포 상태도 표시하지 않는다. 그래서 태그만 찍으면
// "커밋 히스토리만 보고 어디까지 배포됐는지" 알 수 없다. 릴리즈 시 트리가 부모와 동일한
// 빈 커밋 하나를 main 에 남기고 그 커밋에 태그를 달아 커밋 목록에서 경계가 보이게 한다.

/** 마커 커밋 제목 접두사. */
export const RELEASE_MARKER_PREFIX = "chore(release): ";

/** 마커 커밋 메시지. 본문 `[skip ci]` 는 push→main 정적 게이트 중복 실행을 막는다.
 *  배포 워크플로우는 workflow_dispatch 라 skip 지시어의 영향을 받지 않는다. */
export function releaseMarkerMessage(tag: string): string {
  return `${RELEASE_MARKER_PREFIX}${tag}\n\n[skip ci]`;
}

/** 마커 커밋인가(제목 기준). 마커 연쇄 방지 + 출시노트 커밋 집계 제외에 사용. */
export function isReleaseMarkerMessage(message: string): boolean {
  return message.split("\n")[0].startsWith(RELEASE_MARKER_PREFIX);
}

/** 출시노트 집계에서 마커 커밋 제목을 제외한다(코드 변경이 없는 커밋). */
export function excludeReleaseMarkers(messages: string[]): string[] {
  return messages.filter((m) => !isReleaseMarkerMessage(m));
}

/**
 * 마커 커밋을 남길지 판단(순수). 아래 중 하나라도 해당하면 남기지 않는다.
 * - 태그가 이미 존재(재실행) → 기존 태그 커밋을 유지해야 멱등
 * - 대상 ref 가 브랜치가 아님, 또는 그 사이 브랜치가 움직임 → 임의 브랜치 이동 금지
 * - 부모가 이미 마커 커밋 → 직전 릴리즈 이후 새 커밋이 없으므로 마커 연쇄 방지
 */
export function shouldPushReleaseMarker(input: {
  tagAlreadyExists: boolean;
  branchHeadSha: string | null;
  targetSha: string;
  parentMessage: string;
}): boolean {
  if (input.tagAlreadyExists) return false;
  if (!input.branchHeadSha || input.branchHeadSha !== input.targetSha) return false;
  return !isReleaseMarkerMessage(input.parentMessage);
}
