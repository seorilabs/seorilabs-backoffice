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
