import assert from "node:assert/strict";
import test from "node:test";
import { narrativeFacts } from "@/lib/core/metric-narrative";
import { evaluateMovement, type PortfolioTotals } from "@/lib/core/metric-highlights";

const REF = "2026-08-28";
const TOTALS: PortfolioTotals = {
  ga4Dau: { latest: 75, previous: 86, apps: 5 },
  console: { iaaKrw: 38, iapKrw: 0, previousIaaKrw: 25, listings: 10 },
};

const move = (o: Parameters<typeof evaluateMovement>[0]) => evaluateMovement(o);

test("해설에 넘기는 사실은 이미 계산이 끝난 결과뿐이다", () => {
  const facts = narrativeFacts({
    refDate: REF,
    totals: TOTALS,
    movements: [
      move({ label: "루시드 체스", metricKey: "ga4_dau", latest: 4, baseline: 8, date: REF }),
      move({ label: "무변동", metricKey: "ga4_dau", latest: 21, baseline: 20, date: REF }),
    ],
  });
  assert.ok(facts.includes(`기준일: ${REF} (D-1)`));
  assert.ok(facts.includes("GA4 DAU 합계 75명 (전일 86)"));
  assert.ok(facts.includes("루시드 체스 · GA4 DAU: 4명 (기준 8명) -50% · 하락"));
  // 판정에서 빠진 항목은 건수만 넘긴다 — 개별 앱 이름을 주면 LLM 이 없는 이야기를 만든다.
  assert.ok(facts.includes("변동 없음 1건"));
  assert.ok(!facts.includes("무변동"));
});

test("변동이 없으면 그 사실만 넘긴다", () => {
  const facts = narrativeFacts({ refDate: REF, totals: TOTALS, movements: [] });
  assert.ok(facts.includes("임계를 넘은 변동 없음"));
  assert.ok(!facts.includes("임계를 넘은 변동:"));
});

test("신규 등장은 변화율 대신 신규로 넘긴다", () => {
  const facts = narrativeFacts({
    refDate: REF,
    totals: TOTALS,
    movements: [move({ label: "첫 매출", metricKey: "console_iap", latest: 24_000, baseline: 0, date: REF })],
  });
  assert.ok(facts.includes("신규"), facts);
  assert.ok(!facts.includes("Infinity") && !facts.includes("NaN"), facts);
});

test("잔존율은 %p 로, 나머지는 % 로 넘겨 단위가 섞이지 않는다", () => {
  const facts = narrativeFacts({
    refDate: REF,
    totals: TOTALS,
    movements: [
      move({ label: "A", metricKey: "ga4_d1", latest: 30, baseline: 12, sample: 40, date: REF }),
      move({ label: "B", metricKey: "ga4_dau", latest: 40, baseline: 20, date: REF }),
    ],
  });
  assert.ok(facts.includes("+18.0%p"), facts);
  assert.ok(facts.includes("+100%"), facts);
});

test("지연 스냅샷도 사실 목록에 그대로 실린다", () => {
  const facts = narrativeFacts({
    refDate: REF,
    totals: TOTALS,
    movements: [move({ label: "지연 앱", metricKey: "console_dau", latest: 30, baseline: 10, date: "2026-08-25" })],
  });
  assert.ok(facts.includes("지연 앱"));
});

// ── 수집 상태 ──────────────────────────────────────────────────────────
// 기준일 스냅샷이 없는 앱의 수치는 "떨어진 것"이 아니라 "아직 모르는 것"이다.
// 그 구분을 사실로 넘기지 않으면 해설이 합계 하락을 지표 악화로 읽는다.
const ga4App = (slug: string, displayName: string, dates: string[]) => ({
  app: { id: slug, slug, displayName, type: "GAME" as const },
  rowsDesc: dates.map((d) => ({
    date: new Date(`${d}T00:00:00.000Z`),
    dau: 1,
    newUsers: 0,
    d1Pct: null,
    adCompletions: 0,
    engagedUsers: 0,
  })),
});

test("수집 상태: 기준일 스냅샷이 없는 앱은 지연과 미수집을 구분해 넘긴다", () => {
  const facts = narrativeFacts({
    refDate: REF,
    totals: TOTALS,
    movements: [],
    ga4Series: [
      ga4App("on-time", "제때 앱", [REF]),
      ga4App("late", "지각 앱", ["2026-08-26"]),
      ga4App("never", "무수집 앱", []),
    ] as never,
  });
  assert.match(facts, /GA4 기준일 스냅샷: 3개 앱 중 1개 보유/);
  assert.match(facts, /기준일 스냅샷이 없는 앱 2개/);
  assert.match(facts, /지각 앱\(GAME, 2일 지연\)/);
  assert.match(facts, /무수집 앱\(GAME, 수집 없음\)/);
  // 제때 들어온 앱은 공백 목록에 없다.
  assert.doesNotMatch(facts, /제때 앱\(/);
});

test("수집 상태: 시계열을 주지 않으면 기존 사실만 넘긴다", () => {
  const facts = narrativeFacts({ refDate: REF, totals: TOTALS, movements: [] });
  assert.doesNotMatch(facts, /수집 상태/);
});

test("수집 상태: 콘솔은 자기 최신 기준일과 보고서 기준일의 차이를 밝힌다", () => {
  const consoleListing = (label: string, date: string) => ({
    app: { id: label, slug: label, displayName: label, type: "GAME" as const },
    miniAppId: 1,
    label,
    listingLabel: null,
    rowsDesc: [{ date: new Date(`${date}T00:00:00.000Z`), dau: 1 }],
  });
  const facts = narrativeFacts({
    refDate: REF,
    totals: TOTALS,
    movements: [],
    ga4Series: [ga4App("on-time", "제때 앱", [REF])] as never,
    consoleSeries: [
      consoleListing("최신 리스팅", "2026-08-27"),
      consoleListing("밀린 리스팅", "2026-08-20"),
    ] as never,
    consoleMissing: ["수집 없는 리스팅"],
  });
  assert.match(facts, /콘솔 최신 스냅샷 기준일 2026-08-27/);
  assert.match(facts, /보고서 기준일과 1일 차이/);
  assert.match(facts, /그 기준일 스냅샷 보유 1\/3개 리스팅/);
  assert.match(facts, /콘솔 수집이 한 번도 없는 리스팅 1개: 수집 없는 리스팅/);
});
