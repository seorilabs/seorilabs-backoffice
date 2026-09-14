import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { evaluateMovement, type ConsoleRow, type Ga4Row, type HighlightData } from "@/lib/core/metric-highlights";
import {
  alignTrendGrid,
  assembleOrgReportDocument,
  correctionLine,
  factsFingerprint,
} from "@/lib/core/org-report";
import { parseOrgReportDocument } from "@/lib/core/org-report-schema";

const REF = "2026-08-31";
const GENERATED = new Date("2026-09-01T02:00:00.000Z");

function ga4Row(date: string, dau: number, overrides: Partial<Ga4Row> = {}): Ga4Row {
  return {
    date: new Date(`${date}T00:00:00.000Z`),
    dau,
    newUsers: 0,
    d1Pct: null,
    adCompletions: 0,
    engagedUsers: 0,
    dauAndroid: 0,
    dauIos: 0,
    dauWeb: 0,
    ...overrides,
  };
}

function consoleRow(date: string, overrides: Partial<ConsoleRow> = {}): ConsoleRow {
  return {
    date: new Date(`${date}T00:00:00.000Z`),
    dau: null,
    newUsers: null,
    iaaEarningKrw: 0,
    iapTrxAmountKrw: 0,
    iapSettlementKrw: 0,
    payingUsers: 0,
    ...overrides,
  };
}

/** 게임 1(GA4+콘솔) + 비게임 1(콘솔만) 구성의 대표 재료. */
function sampleData(): HighlightData {
  const farm = { id: "a1", slug: "happy-farm", displayName: "행복 농장 타이쿤", type: "GAME" as const };
  const trait = { id: "a2", slug: "trait-test-hub", displayName: "성향 테스트 허브", type: "APP" as const };
  return {
    refDate: REF,
    asOf: null,
    consoleStale: [],
    consoleRefDate: REF,
    totals: {
      ga4Dau: { latest: 60, previous: 50, apps: 1 },
      console: { iaaKrw: 2_500, iapKrw: 1_000, previousIaaKrw: 2_000, listings: 2 },
      referrers: [{ dimension: "전체탭", rate: 0.8 }],
    },
    ga4Gaps: [],
    movements: [
      evaluateMovement({
        label: "행복 농장 타이쿤",
        metricKey: "ga4_dau",
        latest: 60,
        baseline: 40,
        date: REF,
      }),
    ],
    ga4Series: [
      {
        app: farm,
        rowsDesc: [
          ga4Row(REF, 60, {
            newUsers: 6,
            d1Pct: 22,
            engagedUsers: 40,
            adCompletions: 30,
            dauAndroid: 40,
            dauIos: 10,
            dauWeb: 10,
          }),
          ga4Row("2026-08-30", 50, { dauAndroid: 35, dauIos: 8, dauWeb: 7 }),
          ga4Row("2026-08-29", 44),
          ga4Row("2026-08-28", 48),
          ga4Row("2026-08-27", 46),
        ],
      },
    ],
    consoleSeries: [
      {
        app: farm,
        miniAppId: 31877,
        label: "행복 농장 타이쿤",
        listingLabel: null,
        rowsDesc: [
          consoleRow(REF, { dau: 30, newUsers: 3, iaaEarningKrw: 2_000, iapTrxAmountKrw: 1_000, iapSettlementKrw: 700, payingUsers: 1 }),
          consoleRow("2026-08-30", { dau: 28, iaaEarningKrw: 1_800 }),
        ],
      },
      {
        // 온디맨드 push 라 이 리스팅만 하루 늦다.
        app: trait,
        miniAppId: 54985,
        label: "성향 테스트 허브",
        listingLabel: null,
        rowsDesc: [consoleRow("2026-08-30", { dau: 12, iaaEarningKrw: 500 })],
      },
    ],
    consoleMissing: ["두뇌 퍼즐(웹)"],
  };
}

function assemble(overrides: Partial<Parameters<typeof assembleOrgReportDocument>[0]> = {}) {
  return assembleOrgReportDocument({
    data: sampleData(),
    narrative: "농장 상승이 두 소스에서 함께 보인다.",
    costs: null,
    origin: "published",
    generatedAt: GENERATED,
    ...overrides,
  });
}

test("조립된 문서는 정본 스키마를 그대로 통과한다", () => {
  const doc = assemble();
  assert.deepEqual(parseOrgReportDocument(JSON.parse(JSON.stringify(doc))), doc);
});

test("요약·플랫폼 분해는 기준일 스냅샷이 있는 앱들의 합이다", () => {
  const doc = assemble();
  assert.deepEqual(doc.summary.ga4, {
    dau: 60,
    dauPrev: 50,
    newUsers: 6,
    engagedUsers: 40,
    adCompletions: 30,
    apps: 1,
  });
  assert.deepEqual(doc.platform, {
    android: { dau: 40, dauPrev: 35 },
    ios: { dau: 10, dauPrev: 8 },
    web: { dau: 10, dauPrev: 7 },
  });
  // 콘솔 합계는 리스팅별 최신 스냅샷 기준(하이라이트 totals 와 같은 규칙).
  assert.deepEqual(doc.summary.console, {
    iaaKrw: 2_500,
    iaaPrevKrw: 2_000,
    iapTrxKrw: 1_000,
    iapSettlementKrw: 700,
    payingUsers: 1,
    listings: 2,
  });
});

test("게임/비게임 분해는 App.type 으로 가르고 양쪽 소스의 앱을 모두 센다", () => {
  const doc = assemble();
  assert.deepEqual(doc.segments.game, { apps: 1, dau: 60, dauPrev: 50, iaaKrw: 2_000, iapTrxKrw: 1_000 });
  // 비게임은 GA4 시계열이 없어 dau 0·dauPrev null, 수익은 콘솔에서 온다.
  assert.deepEqual(doc.segments.app, { apps: 1, dau: 0, dauPrev: null, iaaKrw: 500, iapTrxKrw: 0 });
});

test("앱별 분해는 전일·7일 중앙값 대비와 리스팅 지연을 함께 싣는다", () => {
  const doc = assemble();
  const farm = doc.apps.find((app) => app.slug === "happy-farm");
  assert.ok(farm?.ga4);
  assert.equal(farm.ga4.dauPrev, 50);
  // 직전 관측 4일 [50, 44, 48, 46] 의 중앙값.
  assert.equal(farm.ga4.dau7dMedian, 47);
  assert.deepEqual(farm.listings[0].lagDays, 0);

  const trait = doc.apps.find((app) => app.slug === "trait-test-hub");
  assert.ok(trait);
  assert.equal(trait.ga4, null);
  assert.equal(trait.listings[0].lagDays, 1);
});

test("직전 관측이 4일 미만이면 중앙값 기준선을 세우지 않는다", () => {
  const data = sampleData();
  data.ga4Series[0].rowsDesc = data.ga4Series[0].rowsDesc.slice(0, 4); // 최신 + 직전 3일
  const doc = assemble({ data });
  assert.equal(doc.apps.find((app) => app.slug === "happy-farm")?.ga4?.dau7dMedian, null);
});

test("consoleMeta 는 최신 push 날짜·지연·기준일 리스팅 수·미수집을 기록한다", () => {
  const doc = assemble();
  assert.deepEqual(doc.consoleMeta, {
    refDate: REF,
    lagDays: 0,
    listings: 3,
    onRefDate: 1,
    missing: ["두뇌 퍼즐(웹)"],
  });
});

test("콘솔 시계열이 아예 없으면 consoleMeta 는 null 필드로 정직하게 빈다", () => {
  const data = sampleData();
  data.consoleSeries = [];
  data.consoleMissing = [];
  const doc = assemble({ data });
  assert.deepEqual(doc.consoleMeta, { refDate: null, lagDays: null, listings: 0, onRefDate: 0, missing: [] });
});

test("재계산 문서는 해설·비용 없이 origin 만 다르게 나온다", () => {
  const published = assemble();
  const recomputed = assemble({ narrative: null, costs: null, origin: "recomputed" });
  assert.equal(recomputed.origin, "recomputed");
  assert.equal(recomputed.narrative, null);
  assert.equal(recomputed.costs, null);
  // 수치는 발행 문서와 동일하다 — 같은 조립기를 쓰는 것이 재계산 fallback 의 전제다.
  assert.deepEqual(recomputed.summary, published.summary);
  assert.deepEqual(recomputed.apps, published.apps);
});

// ── alignTrendGrid: 추이 시계열의 선택일 끝점 격자 ──────────────────────────

const GA4_SUMS = { dau: 60, newUsers: 6, adCompletions: 30, dauAndroid: 40, dauIos: 10, dauWeb: 10 };
const CONSOLE_SUMS = { dau: 30, iaaEarningKrw: 2_000, iapTrxAmountKrw: 0 };

test("추이 격자는 선택일을 끝점으로 과거 N일을 이어 만든다", () => {
  const grid = alignTrendGrid(
    "2026-08-31",
    4,
    new Map([
      ["2026-08-31", GA4_SUMS],
      ["2026-08-28", GA4_SUMS],
    ]),
    new Map([["2026-08-31", CONSOLE_SUMS]]),
  );
  // 오래된→최신, 선택일 포함 정확히 4일.
  assert.deepEqual(grid.map((point) => point.date), [
    "2026-08-28",
    "2026-08-29",
    "2026-08-30",
    "2026-08-31",
  ]);
  assert.equal(grid[3].ga4Dau, 60);
  assert.equal(grid[3].consoleIaaKrw, 2_000);
  // 과거 날짜를 선택하면 그 날짜가 끝점이 된다 — 과거 추이를 이어서 본다.
  const past = alignTrendGrid("2026-08-29", 2, new Map([["2026-08-28", GA4_SUMS]]), new Map());
  assert.deepEqual(past.map((point) => point.date), ["2026-08-28", "2026-08-29"]);
  assert.equal(past[0].ga4Dau, 60);
});

test("수집이 없는 날은 0 이 아니라 null 로 남아 차트가 선을 끊는다", () => {
  const grid = alignTrendGrid(
    "2026-08-31",
    4,
    new Map([
      ["2026-08-31", GA4_SUMS],
      ["2026-08-28", GA4_SUMS],
    ]),
    new Map(),
  );
  assert.equal(grid[1].ga4Dau, null);
  assert.equal(grid[2].ga4Dau, null);
  assert.equal(grid[1].consoleIaaKrw, null);
  // 콘솔 dau 가 전 리스팅 null(미집계)이면 합산도 null 로 보존된다.
  const nullDau = alignTrendGrid(
    "2026-08-31",
    1,
    new Map(),
    new Map([["2026-08-31", { ...CONSOLE_SUMS, dau: null }]]),
  );
  assert.equal(nullDau[0].consoleDau, null);
  assert.equal(nullDau[0].consoleIaaKrw, 2_000);
});

test("판정 전량이 직렬화되어 문서에 남는다", () => {
  const doc = assemble();
  assert.equal(doc.movements.length, 1);
  assert.equal(doc.movements[0].metricKey, "ga4_dau");
  assert.equal(doc.movements[0].verdict, "highlight");
  assert.ok(!("spec" in doc.movements[0]));
});

// ── 정정 경계 ────────────────────────────────────────────────────────────
// 발행분을 하루 뒤에 다시 계산해 사실이 달라졌으면 같은 메시지를 고친다. 경계가
// 무너지면 (1) 바뀐 것이 없는데 version 이 오르거나 (2) 정정이 새 메시지로 나가
// 어느 쪽이 맞는지 읽는 사람이 모르게 된다. 소스로 고정한다.
const readSource = (relative: string) =>
  readFileSync(join(process.cwd(), relative), "utf8");

const reconcileBody = () => {
  const source = readSource("src/lib/core/org-report.ts");
  const start = source.indexOf("export async function reconcileOrgReport");
  assert.ok(start > 0, "reconcileOrgReport 이 있어야 한다");
  const end = source.indexOf("\nexport ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
};

test("사실이 같으면 아무것도 쓰지 않는다", () => {
  const body = reconcileBody();
  assert.match(body, /published\.factsHash === facts[\s\S]{0,200}?action: "none"/u);
});

test("정정은 새 메시지가 아니라 같은 메시지를 고친다", () => {
  const body = reconcileBody();
  // requeueNotification 이 SENT 를 PENDING 으로 되돌려야 providerMessageId 가 남고
  // 워커가 editOrSend 로 같은 카드를 고친다.
  assert.match(body, /requeueNotification\(sent\.eventId\)/u);
  const highlights = readSource("src/lib/core/metric-highlights.ts");
  assert.match(highlights, /payload: \{ text: body, sender: SEORI_SENDER, editable: true \}/u);
});

test("정정은 비용을 다시 부르지 않는다", () => {
  // 과거 시점의 비용은 복원할 수 없다. 다시 부르면 오늘 값이 그 날 문서에 들어간다.
  assert.doesNotMatch(reconcileBody(), /collectFinanceCosts/u);
});

test("수치가 바뀌면 해설도 다시 만든다", () => {
  // 09-12 스냅샷은 dau=138 인데 해설은 "32→30 으로 2명 감소"였다. 수치만 갱신하고
  // 해설을 이어 붙이면 문서가 자기 자신과 모순된다.
  assert.match(reconcileBody(), /metricNarrative\(data\)/u);
});

test("발행 기록이 없으면 그 실행이 최초 발행이 된다", () => {
  const body = reconcileBody();
  assert.match(body, /action: published \? "corrected" : "published"/u);
});

test("정정 라우트는 날짜 형식을 검증한다", () => {
  const route = readSource("src/app/api/admin/metric-highlights/reconcile/route.ts");
  assert.match(route, /parseMetricDay\(raw\) === null/u);
  assert.match(route, /reconcileOrgReport\(/u);
});

// ── 추이 격자: 부분 관측일은 낮은 합계가 아니라 모르는 값이다 ────────────────

test("일부 앱만 수집된 날은 합계 대신 null 로 끊는다", () => {
  const ga4 = new Map([
    ["2026-09-11", { dau: 122, newUsers: 5, adCompletions: 0, dauAndroid: 40, dauIos: 50, dauWeb: 32 }],
    // 이 날 도마뱀이 빠져 15 로 집계됐다. 그대로 그리면 포트폴리오 급감으로 보인다.
    ["2026-09-12", { dau: 15, newUsers: 1, adCompletions: 0, dauAndroid: 6, dauIos: 3, dauWeb: 6 }],
  ]);
  const coverage = new Map([
    ["2026-09-11", { observed: 9, expected: 9 }],
    ["2026-09-12", { observed: 2, expected: 9 }],
  ]);
  const points = alignTrendGrid("2026-09-12", 2, ga4, new Map(), coverage);
  assert.equal(points[0].ga4Dau, 122);
  assert.equal(points[1].ga4Dau, null);
  assert.equal(points[1].dauAndroid, null);
});

test("커버리지를 주지 않으면 기존 동작 그대로", () => {
  const ga4 = new Map([
    ["2026-09-12", { dau: 15, newUsers: 1, adCompletions: 0, dauAndroid: 6, dauIos: 3, dauWeb: 6 }],
  ]);
  const points = alignTrendGrid("2026-09-12", 1, ga4, new Map());
  assert.equal(points[0].ga4Dau, 15);
});

test("콘솔 축은 GA4 커버리지에 묶이지 않는다", () => {
  const console_ = new Map([["2026-09-12", { dau: 27, iaaEarningKrw: 140, iapTrxAmountKrw: 0 }]]);
  const coverage = new Map([["2026-09-12", { observed: 2, expected: 9 }]]);
  const points = alignTrendGrid("2026-09-12", 1, new Map(), console_, coverage);
  assert.equal(points[0].ga4Dau, null);
  assert.equal(points[0].consoleIaaKrw, 140);
});

// ── 사실 지문: 정정 판단의 근거 ────────────────────────────────────────────

test("해설이 달라져도 사실이 같으면 지문이 같다", () => {
  // 본문을 해싱하면 LLM 해설이 실행마다 달라져 매일 정정으로 판정된다.
  const base = sampleData();
  assert.equal(factsFingerprint(base), factsFingerprint({ ...base }));
});

test("합계가 달라지면 지문이 달라진다", () => {
  const base = sampleData();
  const moved = {
    ...base,
    totals: { ...base.totals, ga4Dau: { ...base.totals.ga4Dau, latest: 142 } },
  };
  assert.notEqual(factsFingerprint(base), factsFingerprint(moved));
});

test("커버리지가 달라지면 지문이 달라진다", () => {
  // 같은 합계라도 "몇 개를 세고 나온 값인가"가 바뀌면 다른 사실이다.
  const base = sampleData();
  const covered = {
    ...base,
    asOf: {
      day: REF,
      verdict: "final" as const,
      observed: 9,
      expected: 9,
      missing: [],
      missingWeightShare: 0,
      sealed: true,
    },
  };
  assert.notEqual(factsFingerprint(base), factsFingerprint(covered));
});

test("정정 문구는 무엇이 얼마나 바뀌었는지 적는다", () => {
  assert.equal(
    correctionLine({ previousDau: 15, previousApps: 2, currentDau: 142, currentApps: 6 }),
    "♻️ 정정 — 늦게 도착한 수집을 반영했습니다 (GA4 DAU 합계 15 → 142명, 대상 2 → 6개 앱).",
  );
  // 대상 수가 그대로면 앱 수를 적지 않는다.
  assert.equal(
    correctionLine({ previousDau: 100, previousApps: 6, currentDau: 104, currentApps: 6 }),
    "♻️ 정정 — 늦게 도착한 수집을 반영했습니다 (GA4 DAU 합계 100 → 104명).",
  );
});

// ── 소급 재계산 경계 ──────────────────────────────────────────────────────
// 과거 발행분을 현재 원본으로 덮되, 무엇이 발행됐었는지는 남아야 한다. 그리고
// 메시지가 아직 살아 있는 날(발행 기록 보유)은 정정 경로가 담당한다.

const recomputeBody = () => {
  const source = readSource("src/lib/core/org-report.ts");
  const start = source.indexOf("export async function recomputeOrgReports");
  assert.ok(start > 0, "recomputeOrgReports 가 있어야 한다");
  const end = source.indexOf("\nexport ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
};

test("재계산은 발행 기록이 있는 날을 건드리지 않는다", () => {
  // 그 날들은 Discord 메시지가 살아 있어 수치만 바꾸면 메시지와 문서가 갈린다.
  assert.match(recomputeBody(), /previous\?\.published[\s\S]{0,200}?skippedPublished\.push\(day\)/u);
});

test("재계산은 덮기 전 발행 수치를 남긴다", () => {
  const body = recomputeBody();
  assert.match(body, /superseded: existing/u);
  assert.match(body, /ga4Dau: existing\.ga4Dau/u);
});

test("재계산 문서는 해설·비용을 이어 붙이지 않는다", () => {
  // 수치가 바뀐 문서에 옛 해설을 잇는 것이 애초의 결함이었다(09-12: dau 138 옆에
  // "32→30 으로 2명 감소").
  const body = recomputeBody();
  assert.match(body, /narrative: null/u);
  assert.match(body, /costs: null/u);
  assert.match(body, /origin: "recomputed"/u);
});

test("재계산 라우트는 범위를 검증하고 기본 종료일을 어제로 둔다", () => {
  const route = readSource("src/app/api/admin/report/recompute/route.ts");
  assert.match(route, /parseMetricDay\(req\.nextUrl\.searchParams\.get\("from"\)\)/u);
  assert.match(route, /lastElapsedMetricDay\(new Date\(\)\)/u);
});
