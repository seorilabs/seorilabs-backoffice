import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { narrativeFacts } from "@/lib/core/metric-narrative";
import {
  evaluateMovement,
  type ConsoleListingSeries,
  type ConsoleRow,
  type Ga4AppGap,
  type PortfolioTotals,
} from "@/lib/core/metric-highlights";

const consoleRow = (date: string): ConsoleRow => ({
  date: new Date(`${date}T00:00:00.000Z`),
  dau: 1,
  newUsers: 0,
  iaaEarningKrw: 0,
  iapTrxAmountKrw: 0,
  iapSettlementKrw: 0,
  payingUsers: 0,
});

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
const gap = (
  displayName: string,
  latest: string | null,
  type: "GAME" | "APP" = "GAME",
): Ga4AppGap => ({
  app: { id: displayName, slug: displayName, displayName, type },
  latestDate: latest === null ? null : new Date(`${latest}T00:00:00.000Z`),
});

test("수집 상태: 기준일 스냅샷이 없는 앱은 지연과 미수집을 구분해 넘긴다", () => {
  const facts = narrativeFacts({
    refDate: REF,
    totals: TOTALS,
    movements: [],
    // 기준일 스냅샷을 가진 앱 1개 + 공백 2개.
    ga4Series: [{ app: gap("제때 앱", REF).app, rowsDesc: [] }],
    ga4Gaps: [gap("지각 앱", "2026-08-26"), gap("무수집 앱", null)],
  });
  assert.match(facts, /GA4 기준일 스냅샷: 3개 앱 중 1개 보유/);
  assert.match(facts, /기준일 스냅샷이 없는 앱 2개/);
  assert.match(facts, /지각 앱\(GAME, 2일 지연\)/);
  assert.match(facts, /무수집 앱\(GAME, 수집 없음\)/);
  assert.doesNotMatch(facts, /제때 앱\(/);
});

test("수집 상태: 공백이 없으면 보유 수만 넘긴다", () => {
  const facts = narrativeFacts({
    refDate: REF,
    totals: TOTALS,
    movements: [],
    ga4Series: [{ app: gap("제때 앱", REF).app, rowsDesc: [] }],
    ga4Gaps: [],
  });
  assert.match(facts, /GA4 기준일 스냅샷: 1개 앱 중 1개 보유/);
  assert.doesNotMatch(facts, /기준일 스냅샷이 없는 앱/);
});

test("수집 상태: 시계열을 주지 않으면 기존 사실만 넘긴다", () => {
  const facts = narrativeFacts({ refDate: REF, totals: TOTALS, movements: [] });
  assert.doesNotMatch(facts, /수집 상태/);
});

test("수집 상태: 콘솔은 자기 최신 기준일과 보고서 기준일의 차이를 밝힌다", () => {
  const consoleListing = (label: string, date: string): ConsoleListingSeries => ({
    app: { id: label, slug: label, displayName: label, type: "GAME" },
    miniAppId: 1,
    label,
    listingLabel: null,
    rowsDesc: [consoleRow(date)],
  });
  const facts = narrativeFacts({
    refDate: REF,
    totals: TOTALS,
    movements: [],
    ga4Series: [{ app: gap("제때 앱", REF).app, rowsDesc: [] }],
    ga4Gaps: [],
    consoleSeries: [
      consoleListing("최신 리스팅", "2026-08-27"),
      consoleListing("밀린 리스팅", "2026-08-20"),
    ],
    consoleMissing: ["수집 없는 리스팅"],
  });
  assert.match(facts, /콘솔 최신 스냅샷 기준일 2026-08-27/);
  assert.match(facts, /보고서 기준일과 1일 차이/);
  assert.match(facts, /그 기준일 스냅샷 보유 1\/3개 리스팅/);
  assert.match(facts, /콘솔 수집이 한 번도 없는 리스팅 1개: 수집 없는 리스팅/);
});

// ── 실제 호출 경로 ──────────────────────────────────────────────────────
// ga4Series 는 기준일 스냅샷이 있는 앱만 담는다(합계를 오염시키지 않으려고). 그래서
// 공백을 ga4Series 로 추론하려 하면 실제 경로에서는 언제나 "100% 보유"가 된다.
// collectHighlightData 가 빠진 앱을 ga4Gaps 로 따로 남기고, 두 호출부가 그 필드를
// 그대로 넘기는지 소스로 고정한다.
test("collectHighlightData 는 기준일 스냅샷이 없는 앱을 ga4Gaps 로 남긴다", () => {
  const source = readFileSync(
    join(process.cwd(), "src/lib/core/metric-highlights.ts"),
    "utf8",
  );
  // 건너뛰는 자리에서 기록한다. 기록 없이 continue 하면 공백이 사라진다.
  assert.match(
    source,
    /isoDate\(rows\[0\]\.date\) !== refDate\) \{[\s\S]{0,400}?ga4Gaps\.push\(/u,
  );
  assert.match(source, /latestDate: rows\[0\]\?\.date \?\? null/u);
  assert.match(source, /return \{ refDate, totals, movements, ga4Series, ga4Gaps,/u);
});

test("두 호출부는 HighlightData 를 그대로 넘겨 ga4Gaps 가 사실에 실린다", () => {
  const highlights = readFileSync(
    join(process.cwd(), "src/lib/core/metric-highlights.ts"),
    "utf8",
  );
  const report = readFileSync(join(process.cwd(), "src/lib/core/org-report.ts"), "utf8");
  // 부분 객체를 새로 만들어 넘기면 ga4Gaps 가 조용히 빠진다.
  assert.match(highlights, /narrativeFacts\(data\)/u);
  assert.match(report, /narrativeFacts\(data\)/u);
});
