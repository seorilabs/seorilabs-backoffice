import assert from "node:assert/strict";
import test from "node:test";
import { evaluateMovement, type ConsoleRow, type Ga4Row, type HighlightData } from "@/lib/core/metric-highlights";
import { alignTrendGrid, assembleOrgReportDocument } from "@/lib/core/org-report";
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
    totals: {
      ga4Dau: { latest: 60, previous: 50, apps: 1 },
      console: { iaaKrw: 2_500, iapKrw: 1_000, previousIaaKrw: 2_000, listings: 2 },
      referrers: [{ dimension: "전체탭", rate: 0.8 }],
    },
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
