// AppsInToss 콘솔 지표 수집 대상(미니앱 리스팅) 매핑.
// 한 App(=repo)이 콘솔에 여러 미니앱으로 등록될 수 있다(예: crossword-puzzle 웹 36555 +
// 네이티브 게임 56407). 그래서 정본은 "리스팅 목록"(AIT_LISTINGS)이며, App↔miniApp 은 1:N 이다.
// 진실원본은 DB(App.aitWorkspaceId + App.aitMiniAppId = primary 리스팅)이나, 다중 리스팅과
// 아직 DB 에 안 채워진 앱을 위해 코드 표를 둔다. 이 표는 세 곳에서 정본으로 쓰인다.
//   1) ingest(console-metrics-collect): push 페이로드의 slug/miniAppId 를 App 으로 해석할 때 보조.
//   2) 동기화 상태(getConsoleSyncStatus): 리스팅별 마지막 저장 날짜 판정.
//   3) 로컬 푸셔(runbook): slug/miniAppId → 콘솔 dashboard_* 조회 대상.
//
// 콘솔 워크스페이스는 현재 단일("서일환의 팀 작업공간", 38345). 다계정으로 늘면 리스팅별
// workspaceId 를 분리 저장한다. 표에는 콘솔에 등록된 미니앱(status OPEN/PREPARE)을 넣는다.

export const AIT_WORKSPACE_ID = 38345;

/** 콘솔 미니앱 리스팅 1건. 한 App(appSlug)이 여러 리스팅을 가질 수 있다. */
export interface AitListing {
  /** backoffice App.slug(= repo name). 리스팅→App 해석 키. */
  appSlug: string;
  /** 콘솔 miniAppId. 전역 유일. */
  miniAppId: number;
  /** UI/상태 표기용 짧은 라벨(같은 App 내 리스팅 구분). */
  label: string;
  /** App 당 단일값이 필요한 곳(개요/카드)의 기본 리스팅 여부. App 당 정확히 1개. */
  primary: boolean;
}

/**
 * 콘솔 미니앱 리스팅 정본 표. App 당 여러 리스팅 가능(단일 리스팅 앱은 primary 1개).
 * 다중 리스팅 앱: crossword-puzzle(웹 36555 + 네이티브 게임 56407).
 */
export const AIT_LISTINGS: AitListing[] = [
  { appSlug: "happy-farm", miniAppId: 31877, label: "happy-farm", primary: true },
  { appSlug: "match-picture-app", miniAppId: 32325, label: "match-picture", primary: true },
  { appSlug: "lucid-chess", miniAppId: 34107, label: "lucid-chess", primary: true },
  { appSlug: "dpti-app", miniAppId: 34639, label: "dpti", primary: true },
  // 콘솔 appName 은 "periodic-table" 이나 backoffice App.slug(=repo)는 "periodic-table-app".
  { appSlug: "periodic-table-app", miniAppId: 36076, label: "periodic-table", primary: true },
  // crossword-puzzle repo 는 콘솔에 둘로 등록됨. primary=네이티브 게임(56407, 7/25 론칭, 주력).
  { appSlug: "crossword-puzzle", miniAppId: 56407, label: "네이티브 게임", primary: true },
  { appSlug: "crossword-puzzle", miniAppId: 36555, label: "웹", primary: false },
  { appSlug: "lucid-reversi", miniAppId: 44056, label: "lucid-reversi", primary: true },
  { appSlug: "foam-party", miniAppId: 50736, label: "foam-party", primary: true },
  { appSlug: "babycare", miniAppId: 54868, label: "babycare", primary: true },
  { appSlug: "trait-test-hub", miniAppId: 54985, label: "trait-test-hub", primary: true },
  { appSlug: "lizard-tycoon", miniAppId: 61736, label: "lizard-tycoon", primary: true },
];

/** App 당 primary 리스팅의 miniAppId 표(slug → miniAppId). seed/단일값 조회의 하위호환 경로. */
export const AIT_MINIAPP_BY_SLUG: Record<string, number> = Object.fromEntries(
  AIT_LISTINGS.filter((l) => l.primary).map((l) => [l.appSlug, l.miniAppId]),
);

/** slug 의 모든 콘솔 리스팅(0개 이상). primary 가 먼저 오도록 정렬. */
export function listingsForSlug(slug: string): AitListing[] {
  return AIT_LISTINGS.filter((l) => l.appSlug === slug).sort(
    (a, b) => Number(b.primary) - Number(a.primary),
  );
}

/** slug 의 primary 리스팅(없으면 첫 리스팅, 그것도 없으면 undefined). */
export function primaryListingForSlug(slug: string): AitListing | undefined {
  const list = listingsForSlug(slug);
  return list.find((l) => l.primary) ?? list[0];
}

export interface AitTarget {
  /** 콘솔 워크스페이스 ID. */
  workspaceId: number;
  /** 콘솔 미니앱 ID(primary 리스팅). */
  miniAppId: number;
}

export interface AppAitFields {
  slug: string;
  aitWorkspaceId: number | null;
  aitMiniAppId: number | null;
}

/**
 * 앱의 콘솔 조회 대상(workspace + primary miniApp)을 해석한다. DB 값 우선, 없으면 fallback 표.
 * 다중 리스팅 앱도 여기선 primary 하나만 반환한다(콘솔 유무 게이팅·단일값 조회용).
 */
export function resolveAitTarget(app: AppAitFields): AitTarget | null {
  if (app.aitWorkspaceId && app.aitMiniAppId) {
    return { workspaceId: app.aitWorkspaceId, miniAppId: app.aitMiniAppId };
  }
  const miniAppId = AIT_MINIAPP_BY_SLUG[app.slug];
  if (miniAppId) return { workspaceId: AIT_WORKSPACE_ID, miniAppId };
  return null;
}
