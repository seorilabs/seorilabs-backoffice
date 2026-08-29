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
