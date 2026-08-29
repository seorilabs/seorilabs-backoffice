import assert from "node:assert/strict";
import test from "node:test";
import {
  baselineOf,
  evaluateMovement,
  median,
  metricHighlightDedupeKey,
  movementsFromSeries,
  rankMovements,
  renderHighlightReport,
  type Movement,
  type PortfolioTotals,
} from "@/lib/core/metric-highlights";

const REF = "2026-08-28";

function movement(overrides: Partial<Parameters<typeof evaluateMovement>[0]> = {}): Movement {
  return evaluateMovement({
    label: "행복 농장 타이쿤",
    metricKey: "ga4_dau",
    latest: 420,
    baseline: 250,
    date: REF,
    ...overrides,
  });
}

test("기준선은 하루짜리 튐에 흔들리지 않게 중앙값을 쓴다", () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  // 하루만 10배로 튀어도 기준선은 제자리다.
  assert.equal(baselineOf([100, 100, 100, 5_000, 100]), 100);
});

test("관측일이 모자라면 기준선을 세우지 않는다", () => {
  assert.equal(baselineOf([10, 10, 10]), null);
  assert.equal(baselineOf([10, 10, 10, 10]), 10);
  // null(미수집)은 표본에서 빠진다.
  assert.equal(baselineOf([10, null, 10, null, 10]), null);
  assert.equal(baselineOf([10, null, 10, 10, 10]), 10);
  // 기준선은 직전 7일까지만 본다.
  assert.equal(baselineOf([1, 1, 1, 1, 1, 1, 1, 9_999]), 1);
});

test("표본이 작은 앱은 판정하지 않는다", () => {
  // DAU 기준선 10 미만 — 3명이 6명이 된 것은 소식이 아니다.
  assert.equal(movement({ latest: 6, baseline: 3 }).verdict, "insufficient");
  assert.equal(movement({ baseline: null }).verdict, "insufficient");
});

test("없던 것이 뚜렷하게 생기면 신규 하이라이트로 올린다", () => {
  const first = movement({ metricKey: "console_iap", latest: 24_000, baseline: 0 });
  assert.equal(first.verdict, "highlight");
  assert.equal(first.change, null);
  assert.ok(first.score > 0);
  // 기준선 0 이라도 임계에 못 미치면 표본 부족이다.
  assert.equal(movement({ metricKey: "console_iap", latest: 300, baseline: 0 }).verdict, "insufficient");
});

test("임계 미만 변동은 하이라이트도 로우라이트도 아니다", () => {
  const flat = movement({ latest: 270, baseline: 250 }); // +8%
  assert.equal(flat.verdict, "flat");
  assert.equal(flat.score, 0);
});

test("상승은 하이라이트, 하락은 로우라이트로 갈린다", () => {
  const up = movement({ latest: 420, baseline: 250 });
  assert.equal(up.verdict, "highlight");
  assert.equal(Math.round(up.change as number), 68);
  const down = movement({ latest: 120, baseline: 250 });
  assert.equal(down.verdict, "lowlight");
  assert.equal(Math.round(down.change as number), -52);
});

test("잔존율은 상대 변화가 아니라 %p 로 본다", () => {
  // 12% → 20% 는 상대로 +67% 지만 실제 개선은 8%p 다.
  const up = movement({ metricKey: "ga4_d1", latest: 20, baseline: 12 });
  assert.equal(up.verdict, "flat", "8%p 는 임계 10%p 미만");
  const big = movement({ metricKey: "ga4_d1", latest: 25, baseline: 12 });
  assert.equal(big.verdict, "highlight");
  assert.equal(Math.round(big.change as number), 13);
});

test("정렬은 변화율만이 아니라 규모까지 반영한다", () => {
  const small = movement({ label: "작은 앱", latest: 20, baseline: 10 }); // +100%, 기준선 10
  const large = movement({ label: "큰 앱", latest: 900, baseline: 500 }); // +80%, 기준선 500
  const ranked = rankMovements([small, large], "highlight");
  assert.deepEqual(ranked.map((m) => m.label), ["큰 앱", "작은 앱"]);
});

test("시계열에서 지표별 움직임을 뽑고 미수집 값은 건너뛴다", () => {
  const rows = [
    { date: new Date("2026-08-28T00:00:00Z"), dau: 400, d1Pct: null },
    { date: new Date("2026-08-27T00:00:00Z"), dau: 100, d1Pct: 11 },
    { date: new Date("2026-08-26T00:00:00Z"), dau: 100, d1Pct: 12 },
    { date: new Date("2026-08-25T00:00:00Z"), dau: 100, d1Pct: 12 },
    { date: new Date("2026-08-24T00:00:00Z"), dau: 100, d1Pct: 12 },
  ];
  const movements = movementsFromSeries("행복 농장 타이쿤", rows, [
    { key: "ga4_dau", pick: (row) => row.dau },
    // 최신 행의 값이 null 이면 그 지표는 관측 자체가 없다.
    { key: "ga4_d1", pick: (row) => row.d1Pct },
  ]);
  assert.deepEqual(movements.map((m) => m.metricKey), ["ga4_dau"]);
  assert.equal(movements[0].verdict, "highlight");
  assert.equal(movements[0].date, "2026-08-28");
  assert.deepEqual(movementsFromSeries("빈 앱", [], []), []);
});

const TOTALS: PortfolioTotals = {
  ga4Dau: { latest: 1_234, previous: 1_180, apps: 12 },
  console: { iaaKrw: 45_300, iapKrw: 0, previousIaaKrw: 41_000, listings: 11 },
};

test("리포트는 포트폴리오 합계와 양쪽 목록, 처리 건수를 함께 싣는다", () => {
  const text = renderHighlightReport({
    refDate: REF,
    totals: TOTALS,
    movements: [
      movement({ label: "행복 농장 타이쿤", latest: 420, baseline: 250 }),
      movement({ label: "크로스워드", metricKey: "console_iaa", latest: 400, baseline: 4_000 }),
      movement({ label: "무변동 앱", latest: 260, baseline: 250 }),
      movement({ label: "작은 앱", latest: 6, baseline: 3 }),
    ],
  });
  assert.equal(text.split("\n")[0], `📈 **서리 지표 하이라이트 · ${REF} (D-1)**`);
  assert.ok(text.includes("GA4 DAU 합계 1,234명 (전일 1,180명 · +4.6%) · 대상 12개 앱"));
  assert.ok(text.includes("콘솔 광고 수익 ₩45,300 (전일 ₩41,000 · +10.5%) · 결제 ₩0 · 대상 11개 리스팅"));
  assert.ok(text.includes("🟢 **하이라이트**"));
  assert.ok(text.includes("1. **행복 농장 타이쿤** · GA4 DAU 420명 (기준 250명, +68%)"));
  assert.ok(text.includes("🔴 **로우라이트**"));
  assert.ok(text.includes("1. **크로스워드** · 콘솔 광고 수익 ₩400 (기준 ₩4,000, -90%)"));
  assert.ok(text.endsWith("변동 없음 1건 · 표본 부족 1건 · 관측 4건"));
});

test("움직임이 없으면 없다고 말한다", () => {
  const text = renderHighlightReport({ refDate: REF, totals: TOTALS, movements: [] });
  assert.ok(text.includes("임계를 넘은 변동 없음"));
  assert.ok(!text.includes("🟢"));
  assert.ok(!text.includes("🔴"));
});

test("기준일보다 오래된 스냅샷은 그 날짜를 함께 찍는다", () => {
  const text = renderHighlightReport({
    refDate: REF,
    totals: TOTALS,
    movements: [movement({ label: "지연 앱", metricKey: "console_dau", latest: 300, baseline: 100, date: "2026-08-25" })],
  });
  assert.ok(text.includes("⏳2026-08-25"), text);
});

test("전일 합계가 없으면 변화율을 지어내지 않는다", () => {
  const text = renderHighlightReport({
    refDate: REF,
    totals: {
      ga4Dau: { latest: 100, previous: null, apps: 1 },
      console: { iaaKrw: 0, iapKrw: 0, previousIaaKrw: 0, listings: 0 },
    },
    movements: [],
  });
  assert.ok(text.includes("GA4 DAU 합계 100명 · 대상 1개 앱"));
  // 전일 0 에서 나눗셈으로 Infinity 를 만들지 않는다.
  assert.ok(text.includes("콘솔 광고 수익 ₩0 · 결제 ₩0 · 대상 0개 리스팅"));
});

test("리포트는 기준일 기준 하루 1건이다", () => {
  assert.equal(metricHighlightDedupeKey(REF), "metric-highlight:2026-08-28");
});
