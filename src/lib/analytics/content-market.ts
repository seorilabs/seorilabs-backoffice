// 컨텐츠 지표의 마켓 축 정규화.
//
// 스펙은 두 곳에서 온다 — 레포의 `.seorilabs/backoffice.json`(manifest)과 백오피스 내장
// 레지스트리. 작성자가 달라 같은 마켓이 `apps-in-toss`/`apps_in_toss`/`web` 처럼 여러
// 표기로 저장돼 왔다(2026-08-30 실측: happy-farm 밑줄, crossword 하이픈, foam·slot 플랫폼
// 어휘). 그대로 두면 리포트가 같은 마켓을 둘로 센다.
//
// 어휘는 저장소 전체가 이미 쓰는 것(App.marketTargets, ReleaseMarket)에 맞춘다.

/** 저장·조회에 쓰는 정규 마켓 키. `all` 은 마켓 분해 없는 통합 행이다. */
export const CONTENT_MARKETS = ["all", "ait", "play", "appstore", "web"] as const;

export type ContentMarket = (typeof CONTENT_MARKETS)[number];

/**
 * 표기 변형 → 정규 키.
 *
 * 플랫폼 어휘(android/ios)는 스펙의 platformMap 이 마켓 대신 플랫폼 이름을 키로 쓴 경우다
 * (foam 스펙의 라벨이 각각 "Google Play"/"App Store"). 반면 `web` 은 AIT 서면인지 독립
 * 웹인지 문자열만으로 알 수 없어 추측하지 않고 그대로 둔다 — 스펙이 의도를 알면
 * 스펙 쪽에서 정규 키를 선언한다.
 */
const ALIASES: Record<string, ContentMarket> = {
  all: "all",
  ait: "ait",
  toss: "ait",
  appsintoss: "ait",
  "apps-in-toss": "ait",
  apps_in_toss: "ait",
  play: "play",
  googleplay: "play",
  "google-play": "play",
  google_play: "play",
  android: "play",
  appstore: "appstore",
  "app-store": "appstore",
  app_store: "appstore",
  ios: "appstore",
  web: "web",
};

export function isContentMarket(value: string): value is ContentMarket {
  return (CONTENT_MARKETS as readonly string[]).includes(value);
}

/**
 * 마켓 키를 정규 어휘로 접는다. 모르는 표기는 **버리지 않고 그대로** 돌려준다 —
 * 조용히 삼키면 새 스펙이 오탈자를 내도 드러나지 않는다. 호출부가 정규 여부를 판단한다.
 */
export function normalizeContentMarket(raw: string): string {
  return ALIASES[raw.trim().toLowerCase()] ?? raw.trim();
}

/**
 * 마켓별 값들을 정규 키로 접는다. 서로 다른 표기가 같은 키로 접히면 합칠 근거가 없으므로
 * (스냅샷은 합산 가능한 구조가 아니다) 충돌로 보고한다. 스펙이 같은 마켓을 두 표기로
 * 선언한 버그라 조용히 덮어쓰면 하루치가 사라진다.
 */
export function foldByContentMarket<T>(
  entries: ReadonlyArray<readonly [string, T]>,
): { folded: Array<[string, T]>; collisions: string[] } {
  const seen = new Map<string, string>();
  const folded: Array<[string, T]> = [];
  const collisions: string[] = [];
  for (const [raw, value] of entries) {
    const key = normalizeContentMarket(raw);
    const previous = seen.get(key);
    if (previous !== undefined) {
      collisions.push(`${key}: ${previous} + ${raw}`);
      continue;
    }
    seen.set(key, raw);
    folded.push([key, value]);
  }
  return { folded, collisions };
}
