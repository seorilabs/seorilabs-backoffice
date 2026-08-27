// Play Console 내부 테스트 바로가기 URL 규칙. 백오피스 입력(저장)과 배포 카드 렌더가
// 같은 규칙을 쓴다. 규칙이 두 곳으로 갈리면 저장은 됐는데 카드에는 안 붙는 값이 생긴다.
//
// opt-in URL(play.google.com/apps/internaltest/<id>)은 패키지명에서 파생되지 않아 사람이
// Play Console 에서 복사해 넣는다. 오입력으로 임의 도메인이 카드 버튼에 실리지 않게
// Play 링크만 받는다.

const PLAY_URL_RE = /^https:\/\/play\.google\.com\/[\w\-./?=&%#]*$/;

export type PlayInternalTestUrlInput =
  /** url === null 은 링크 삭제(카드에서 버튼 제거). */
  | { ok: true; url: string | null }
  | { ok: false; error: string };

/** 백오피스 입력값 → 저장할 값. 빈 입력은 삭제로 본다. */
export function parsePlayInternalTestUrl(
  value: string | null | undefined,
): PlayInternalTestUrlInput {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return { ok: true, url: null };
  if (!PLAY_URL_RE.test(trimmed)) {
    return { ok: false, error: "https://play.google.com/ 으로 시작하는 링크만 저장합니다." };
  }
  return { ok: true, url: trimmed };
}

/** 저장된 값 중 카드 링크 버튼에 실을 수 있는 것. 규칙 이전 데이터도 여기서 걸러진다. */
export function playInternalTestLink(url: string | null | undefined): string | null {
  const parsed = parsePlayInternalTestUrl(url);
  return parsed.ok ? parsed.url : null;
}
