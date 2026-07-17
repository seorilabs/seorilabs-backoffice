// AppsInToss 콘솔 지표 수집 대상 앱 매핑.
// 진실원본은 DB(App.aitWorkspaceId + App.aitMiniAppId). 아직 채워지지 않은 앱을 위해
// 코드 내 fallback 표를 둔다(DB 값이 있으면 항상 DB 우선). 이 표는 두 곳에서 정본으로 쓰인다.
//   1) ingest(console-metrics-collect): push 페이로드의 slug/miniAppId 를 App 으로 해석할 때 보조.
//   2) 로컬 스케줄러(claude -p 푸셔): slug → (workspaceId, miniAppId) 를 알아 MCP dashboard_* 를 호출.
//
// 콘솔 워크스페이스는 현재 단일("서일환의 팀 작업공간", 38345). 다계정으로 늘면 슬러그별
// workspaceId 를 분리 저장한다. 표에는 콘솔에 등록된 미니앱(status OPEN/PREPARE)을 넣는다.

export const AIT_WORKSPACE_ID = 38345;

/** slug(= repo name = 콘솔 appName) → 콘솔 miniAppId. workspace 는 AIT_WORKSPACE_ID 단일. */
export const AIT_MINIAPP_BY_SLUG: Record<string, number> = {
  "happy-farm": 31877,
  "match-picture-app": 32325,
  "lucid-chess": 34107,
  "dpti-app": 34639,
  // 콘솔 appName 은 "periodic-table" 이나 backoffice App.slug(=repo)는 "periodic-table-app".
  // 키는 항상 backoffice slug(ingest 가 slug 로 App 해석)여야 하므로 -app 을 붙인다.
  "periodic-table-app": 36076,
  "crossword-puzzle": 36555,
  "vocab-swipe": 36976,
  "lucid-reversi": 44056,
  "foam-party": 50736,
};

export interface AitTarget {
  /** 콘솔 워크스페이스 ID. */
  workspaceId: number;
  /** 콘솔 미니앱 ID. */
  miniAppId: number;
}

export interface AppAitFields {
  slug: string;
  aitWorkspaceId: number | null;
  aitMiniAppId: number | null;
}

/** 앱의 콘솔 조회 대상(workspace+miniApp)을 해석한다. DB 값 우선, 없으면 fallback 표. */
export function resolveAitTarget(app: AppAitFields): AitTarget | null {
  if (app.aitWorkspaceId && app.aitMiniAppId) {
    return { workspaceId: app.aitWorkspaceId, miniAppId: app.aitMiniAppId };
  }
  const miniAppId = AIT_MINIAPP_BY_SLUG[app.slug];
  if (miniAppId) return { workspaceId: AIT_WORKSPACE_ID, miniAppId };
  return null;
}
