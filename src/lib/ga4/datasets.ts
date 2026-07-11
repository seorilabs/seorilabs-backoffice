// GA4 BigQuery export 대상 앱 매핑 + 날짜 유틸.
// 진실원본은 DB(App.firebaseProject + App.ga4Dataset). 아직 채워지지 않은 앱을 위해
// 코드 내 fallback 표를 둔다(DB 값이 있으면 항상 DB 우선). 신규 게임은 DB 또는 이 표에
// 추가하면 수집 대상에 자동 편입된다.
//
// lizard-tycoon 은 dataset 은 확인됐으나 BigQuery 읽기 SA 키가 아직 미발급이다.
// 키가 준비되면(SA 에 dataViewer+jobUser 부여) 별도 변경 없이 자동으로 수집된다.
//
// foam-party 는 propertyId(542197312)를 레포 firebase.config.json 에서 확인했다.
// 다만 config 상 eventDeliveryStatus=not-confirmed(BigQuery export 데이터셋 미확인)라
// GA4→BigQuery export 가 아직 활성화 전일 수 있다. export 가 켜지면 별도 변경 없이 수집된다.
// (설정 > "광고/수익 export 진단" 으로 실동작 확인)

export interface Ga4Target {
  /** BigQuery 프로젝트(= Firebase project id). job 실행/billing 대상. */
  firebaseProject: string;
  /** GA4 export 데이터셋 "analytics_<propertyId>". */
  dataset: string;
}

const FALLBACK: Record<string, Ga4Target> = {
  "lucid-chess": { firebaseProject: "lucid-chess-dbb9d", dataset: "analytics_539665867" },
  "crossword-puzzle": { firebaseProject: "crossword-puzzle-79ae0", dataset: "analytics_539639687" },
  "happy-farm": { firebaseProject: "happy-farm-tycoon", dataset: "analytics_539626577" },
  "lizard-tycoon": { firebaseProject: "lizard-tycoon", dataset: "analytics_544016233" },
  "foam-party": { firebaseProject: "foam-party", dataset: "analytics_542197312" },
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

// ── 날짜 유틸 ────────────────────────────────────────────────────────────
// GA4 일별 export(events_YYYYMMDD)는 보통 다음 날 적재되고 당일 events_intraday_*
// 는 불완전하다. 따라서 "최신 확정일"은 어제(D-1)로 본다. UTC 기준으로 계산한다.

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC 날짜를 GA4 테이블 접미사 "YYYYMMDD" 로. */
export function toTableSuffix(d: Date): string {
  return isoDate(d).replace(/-/g, "");
}

/** UTC 날짜를 "YYYY-MM-DD" 로. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD"(UTC 자정) Date 로 파싱. @db.Date 저장/비교용. */
export function parseIsoDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

/** 최신 확정일(D-1). now 기준 어제 UTC 자정. */
export function latestClosedDay(now: Date): Date {
  return parseIsoDate(isoDate(new Date(now.getTime() - DAY_MS)));
}

/** end(포함)부터 과거로 days 개의 날짜(오래된→최신 순). */
export function dateWindow(end: Date, days: number): Date[] {
  const out: Date[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(parseIsoDate(isoDate(new Date(end.getTime() - i * DAY_MS))));
  }
  return out;
}

/** a 가 b 보다 며칠 뒤인지(정수 일). */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}
