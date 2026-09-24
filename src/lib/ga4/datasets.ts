// GA4 BigQuery export 대상 앱 매핑 + 날짜 유틸.
// 진실원본은 DB(App.firebaseProject + App.ga4Dataset). 아직 채워지지 않은 앱을 위해
// 코드 내 fallback 표를 둔다(DB 값이 있으면 항상 DB 우선). 신규 게임은 DB 또는 이 표에
// 추가하면 수집 대상에 자동 편입된다.
//
// 표에는 (1) GA4→BigQuery export 가 실제 활성(dataset + events_* 적재)이고 (2) 조직 공용
// 수집 SA seori-ga4-reader@seorilabs-ci(카탈로그 shared/gcp/ga4-fleet-reader)에 각 프로젝트
// bigquery.dataViewer+jobUser 가 부여된 게임만 넣는다. 같은 SA 가 GA4 계정 뷰어로 실시간
// 보고서도 읽는다. 둘 중 하나라도 빠지면 매 수집마다 "Dataset not found"/권한 에러가
// 쌓인다(백오피스는 errors 로 잡고 다른 앱 수집은 계속한다).
//
// dataset 이 아직 없는 앱은 raw events 적재와 수집 SA 권한을 확인한 뒤 편입한다.

export interface Ga4Target {
  /** BigQuery 프로젝트(= Firebase project id). job 실행/billing 대상. */
  firebaseProject: string;
  /** GA4 export 데이터셋 "analytics_<propertyId>". */
  dataset: string;
}

const FALLBACK: Record<string, Ga4Target> = {
  "babycare": {
    firebaseProject: "seorilabs-babycare",
    dataset: "analytics_549232169",
  },
  "lucid-chess": { firebaseProject: "lucid-chess-dbb9d", dataset: "analytics_539665867" },
  "crossword-puzzle": { firebaseProject: "crossword-puzzle-79ae0", dataset: "analytics_539639687" },
  "happy-farm": { firebaseProject: "happy-farm-tycoon", dataset: "analytics_539626577" },
  "foam-party": { firebaseProject: "foam-party", dataset: "analytics_542197312" },
  "match-picture-app": { firebaseProject: "match-picture-app", dataset: "analytics_542397319" },
  "slotmachine-game": {
    firebaseProject: "slotmachine-game-495cc",
    dataset: "analytics_547294653",
  },
  "lizard-tycoon": {
    firebaseProject: "lizard-tycoon",
    dataset: "analytics_544016233",
  },
  "spiritgate-defenders": {
    firebaseProject: "spiritgate-defenders",
    dataset: "analytics_549931858",
  },
};

export interface AppGa4Fields {
  slug: string;
  firebaseProject: string | null;
  ga4Dataset: string | null;
}

/** 앱의 GA4 쿼리 대상(프로젝트+데이터셋)을 해석한다. DB 값 우선, 없으면 fallback 표. */
export function resolveGa4Target(app: AppGa4Fields): Ga4Target | null {
  if (app.firebaseProject && app.ga4Dataset) {
    return { firebaseProject: app.firebaseProject, dataset: app.ga4Dataset };
  }
  return FALLBACK[app.slug] ?? null;
}

/** 내부 백필 API의 조회 일수. 평상시에는 undefined로 기본 14일을 유지한다. */
export function parseWindowDays(value: string | null, maxDays = 366): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("windowDays 는 양의 정수여야 합니다.");
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > maxDays) {
    throw new Error(`windowDays 는 1~${maxDays} 범위여야 합니다.`);
  }
  return days;
}
