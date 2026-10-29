import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { evaluateMovement, type ConsoleRow, type Ga4Row, type HighlightData } from "@/lib/core/metric-highlights";
import {
  alignTrendGrid,
  assembleOrgReportDocument,
} from "@/lib/core/org-report";
import { dailyEditionSchema } from "@/lib/report/daily-contract";
import { providerSeriesSchema } from "@/lib/analytics/report-query";
import { dailyReportCsv } from "@/lib/report/daily-csv";
import { reportFactsHash, sameReportFacts, reportCorrectionDiff } from "@/lib/report/daily-presentation";
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
  // 비게임은 GA4 시계열이 없고 콘솔 날짜도 달라 합산과 전일 비교에서 빠진다.
  assert.deepEqual(doc.segments.app, { apps: 1, dau: 0, dauPrev: null, iaaKrw: null, iapTrxKrw: null });
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

test("정정 라우트는 날짜 형식을 검증한다", () => {
  const route = readSource("src/app/api/admin/metric-highlights/reconcile/route.ts");
  assert.match(route, /parseMetricDay\(raw\) === null/u);
  assert.match(route, /correctDailyReport\(/u);
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

test("해설·생성 시각은 정정 지문을 바꾸지 않고 수치는 바꾼다", () => {
  const before = assemble();
  assert.equal(reportFactsHash(before), reportFactsHash({ ...before, narrative: "새 해설", generatedAt: "2026-09-02T02:00:00Z" }));
  const after = structuredClone(before);
  after.summary.ga4.dau = 142;
  assert.notEqual(reportFactsHash(before), reportFactsHash(after));
  assert.ok(reportCorrectionDiff(before, after).some((row) => row.before === "60" && row.after === "142"));
});

test("유입경로 비율만 바뀌어도 정정 대상이다", () => {
  const before = assemble();
  const after = structuredClone(before);
  after.referrers = [{ dimension: "전체탭", rate: 0.7 }];
  assert.notEqual(reportFactsHash(before), reportFactsHash(after));
});

test("유입경로 비율과 추가, 삭제를 정정 내역에 남긴다", () => {
  const before = assemble();
  before.referrers = [{ dimension: "검색", rate: 0.8 }, { dimension: "푸시알림", rate: 0.2 }];
  const after = structuredClone(before);
  after.referrers = [{ dimension: "검색", rate: 0.7 }, { dimension: "전체탭", rate: 0.3 }];
  const changes = reportCorrectionDiff(before, after);
  assert.ok(changes.some((row) => row.label === "검색 유입 비율(%)" && row.before === "80" && row.after === "70"));
  assert.ok(changes.some((row) => row.label === "푸시알림 유입 비율(%)" && row.before === "20" && row.after === "미수집"));
  assert.ok(changes.some((row) => row.label === "전체탭 유입 비율(%)" && row.before === "미수집" && row.after === "30"));
});

test("DB JSON의 부동소수점 직렬화 차이는 정정으로 만들지 않는다", () => {
  const before = assemble();
  before.referrers = [{ dimension: "검색", rate: 0.16783216783216784 }];
  const stored = structuredClone(before);
  stored.referrers = [{ dimension: "검색", rate: 0.1678321678321678 }];
  assert.equal(sameReportFacts(before, stored), true);
  assert.deepEqual(reportCorrectionDiff(before, stored), []);
  stored.referrers[0].rate = 0.17;
  assert.equal(sameReportFacts(before, stored), false);
  assert.notEqual(reportFactsHash(before), reportFactsHash(stored));
});

test("유입경로의 같은 비율을 순서만 바꾸면 정정하지 않는다", () => {
  const before = assemble();
  before.referrers = [{ dimension: "검색", rate: 0.5 }, { dimension: "전체탭", rate: 0.5 }];
  const after = structuredClone(before);
  after.referrers.reverse();
  assert.equal(reportFactsHash(before), reportFactsHash(after));
  assert.deepEqual(reportCorrectionDiff(before, after), []);
});

test("DB JSON에서 객체 키 순서가 바뀌어도 같은 사실로 비교한다", () => {
  const before = assemble();
  const stored = JSON.parse(JSON.stringify(before), (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value);
  assert.equal(reportFactsHash(before), reportFactsHash(stored));
});

test("내부 점수의 JSON 왕복 오차를 정정 내역으로 만들지 않는다", () => {
  const before = assemble();
  before.movements[0].score = 10328.18189471805;
  const after = structuredClone(before);
  after.movements[0].score = 10328.181894718049;
  assert.equal(sameReportFacts(before, after), true);
  assert.deepEqual(reportCorrectionDiff(before, after), []);
  after.movements[0].score += 0.01;
  assert.equal(sameReportFacts(before, after), false);
  after.movements[0].score = before.movements[0].score;
  after.summary.ga4.dau += 1;
  assert.equal(sameReportFacts(before, after), false);
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
  // 그 날들은 Slack 메시지가 살아 있어 수치만 바꾸면 메시지와 문서가 갈린다.
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

test("전날이 비면 앱·플랫폼·분류별 전일 비교도 보류한다", () => {
  const data = sampleData();
  data.ga4Series[0].rowsDesc.splice(1, 1);
  data.totals.ga4Dau.previous = null;
  const doc = assembleOrgReportDocument({ data, narrative: null, costs: null, origin: "published", generatedAt: GENERATED });
  assert.equal(doc.apps.find((app) => app.slug === "happy-farm")?.ga4?.dauPrev, null);
  assert.equal(doc.platform.android.dauPrev, null);
  assert.equal(doc.segments.game.dauPrev, null);
});

test("앱 분류별 수익도 같은 콘솔 기준일의 관측만 합산한다", () => {
  const data = sampleData();
  data.consoleSeries[0].rowsDesc[0].date = new Date("2026-08-29T00:00:00Z");
  const doc = assembleOrgReportDocument({ data, narrative: null, costs: null, origin: "published", generatedAt: GENERATED });
  assert.equal(doc.segments.game.iaaKrw, null);
});

test("비용만 바뀌어도 정정하고 수집 시각만 바뀐 것은 같은 사실이다", () => {
  const before = assemble(), after = assemble();
  before.costs = { month: "2026-09", summaryLines: ["GCP USD 1"], warnings: [], figures: { github: null, gcp: { total: 1, currency: "USD" }, llm: null, stability: null } };
  after.costs = structuredClone(before.costs);
  after.costs.collectedAt = "2026-09-01T01:00:00.000Z";
  assert.equal(reportFactsHash(before), reportFactsHash(after));
  after.costs.figures.gcp!.total = 2;
  assert.notEqual(reportFactsHash(before), reportFactsHash(after));
  assert.ok(reportCorrectionDiff(before, after).some((row) => row.label.includes("비용")));
});


test("정정·CSV가 같은 날짜의 서로 다른 다운로드 의미를 섞지 않는다", () => {
  const before = assemble();
  const series = [120, 5].map((value, index) => providerSeriesSchema.parse({ appId: "a1", appName: "앱", source: "apple-analytics", account: "account", resource: "app", reportType: "App Downloads Standard", timeZone: "UTC", metric: "store_downloads", segment: index ? "Download Type: Redownload" : "Download Type: First-time download", currency: null, unit: "건", definition: "다운로드", dimensions: [], verdict: "insufficient", points: [{ day: REF, value, numerator: null, denominator: null, state: "observed", valueStatus: "analyzable", sourceHash: "hash", sourceUri: "https://api.appstoreconnect.apple.com", runId: "run", configRevisionId: "config" }] }));
  before.edition = dailyEditionSchema.parse({ cutoffAt: GENERATED.toISOString(), dueAt: GENERATED.toISOString(), frozenAt: GENERATED.toISOString(), inputHash: "hash", sources: [], trend: [], cohorts: [], providerMetrics: series, context: [], changes: [], conclusions: [], actions: [] });
  const after = structuredClone(before); after.summary.ga4.dau = 61;
  const changes = reportCorrectionDiff(before, after);
  assert.ok(changes.some((row) => row.label.includes("GA4")));
  assert.equal(changes.some((row) => row.label.includes("store_downloads")), false);
  const csv = dailyReportCsv(after, 2);
  assert.ok(csv.includes("Download Type: Redownload") && csv.includes("Download Type: First-time download"));
});
