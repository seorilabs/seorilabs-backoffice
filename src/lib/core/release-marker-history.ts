// 과거 릴리즈 마커 커밋 읽기 호환(historical read compatibility).
//
// 백오피스는 더 이상 마커 커밋을 만들지 않는다(릴리스 태그는 검증된 소스 SHA 를 직접 가리킨다).
// 다만 폐기 이전에 main 에 쌓인 `chore(release): vX.Y.Z` 커밋은 히스토리에 그대로 남아 있고,
// 출시노트는 그 구간을 계속 compare 한다. 코드 변경이 0 인 커밋이라 집계에 섞이면 안 되므로
// 읽기 경로에서만 제외한다. 새 마커를 만드는 코드는 이 모듈에 없다.

const RELEASE_MARKER_PREFIX = "chore(release): ";

/** 과거 마커 커밋인가(제목 기준). */
export function isHistoricalReleaseMarker(message: string): boolean {
  return message.split("\n")[0].startsWith(RELEASE_MARKER_PREFIX);
}

/** 출시노트 집계에서 과거 마커 커밋 제목만 제외한다. */
export function excludeHistoricalReleaseMarkers(messages: string[]): string[] {
  return messages.filter((message) => !isHistoricalReleaseMarker(message));
}
