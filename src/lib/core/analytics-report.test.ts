import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAppReportMd,
  buildConsoleSection,
  consoleSummaryLine,
  summaryLine,
  type ConsoleMetricRow,
  type ConsoleReportItem,
  type MetricRow,
} from "@/lib/core/analytics-report";

function row(date: string, over: Partial<MetricRow> = {}): MetricRow {
  return {
    date: new Date(`${date}T00:00:00.000Z`),
    dau: 100,
    newUsers: 10,
    d1Pct: 40,
    d3Pct: 20,
    d7Pct: 10,
    engagedUsers: 50,
    avgEngageSec: 120,
    adEventUsers: 20,
    adImpressions: 45,
    adCtaUsers: 8,
    adCtaImpressions: 30,
    adCompletedUsers: 4,
    adCompletions: 5,
    networkAdUsers: 3,
    networkAdImpressions: 4,
    dauAndroid: 70,
    dauIos: 30,
    dauWeb: 0,
    ...over,
  };
}

test("buildAppReportMd: 제목/기준일/추이표 포함, null 은 대시(—)", () => {
  const md = buildAppReportMd(
    "Happy Farm",
    [row("2026-07-04", { d7Pct: null, avgEngageSec: null }), row("2026-07-03")],
    "2026-07-05",
  );
  assert.match(md, /# Happy Farm 지표/);
  assert.match(md, /기준일 2026-07-04/);
  assert.match(md, /· D7 —/); // null → —
  assert.match(md, /평균 —초/);
  assert.match(md, /\| 2026-07-04 \|/); // 추이 표 행
  assert.match(md, /최근 2일 추이/);
  // engagement → 활성사용자 라벨 변경 + 참여율/플랫폼 노출 회귀 잠금
  assert.match(md, /활성사용자 /);
  assert.match(md, /참여율 /);
  assert.match(md, /플랫폼 Android /);
  assert.match(md, /광고 CTA 노출 30 · 고유 8명/);
  assert.match(md, /광고 완료 5 · 고유 4명/);
  assert.match(md, /실제 광고 노출 4 · 고유 3명/);
  assert.doesNotMatch(md, /- 광고 노출 45/);
  assert.doesNotMatch(md, /- engagement /); // 핵심 지표 줄이 옛 라벨로 회귀 방지
});

test("summaryLine: 앱명 볼드 + 핵심 수치, null D7 은 대시, 활성/플랫폼 반영", () => {
  const s = summaryLine("Lucid Chess", row("2026-07-04", { dau: 77, d7Pct: null }));
  assert.match(s, /<b>Lucid Chess<\/b>/);
  assert.match(s, /DAU 77/);
  assert.match(s, /D7 —/);
  assert.match(s, /활성 50/); // engagedUsers
  assert.match(s, /CTA 30 · 완료 5 · 실제노출 4/);
  assert.match(s, /Android 70/); // 플랫폼 반영
});

// ── AppsInToss 콘솔 섹션 ────────────────────────────────────────────────
function consoleRow(date: string, over: Partial<ConsoleMetricRow> = {}): ConsoleMetricRow {
  return {
    date: new Date(`${date}T00:00:00.000Z`),
    dau: 30,
    newUsers: 5,
    avgSessionSec: 128.4,
    iaaImpressions: 120,
    iaaEarningKrw: 1234.6,
    iapTrxAmountKrw: 0,
    payingUsers: 0,
    ...over,
  };
}

function item(
  displayName: string,
  latest: ConsoleMetricRow | null,
  listingLabel: string | null = null,
): ConsoleReportItem {
  return { displayName, listingLabel, latest };
}

test("consoleSummaryLine: 콘솔 핵심 수치, 미집계 DAU 는 대시, 결제 0 은 생략", () => {
  const s = consoleSummaryLine(item("Happy Farm", consoleRow("2026-07-04")), "2026-07-04");
  assert.match(s, /<b>Happy Farm<\/b>/);
  assert.match(s, /DAU 30 · 신규 5 · 세션 128초 · 광고 120회 ₩1,235/);
  assert.doesNotMatch(s, /결제/);
  assert.doesNotMatch(s, /⏳/); // 기준일과 같으면 날짜 배지 없음

  const nullDau = consoleSummaryLine(
    item("Happy Farm", consoleRow("2026-07-04", { dau: null, newUsers: null, avgSessionSec: null })),
    "2026-07-04",
  );
  assert.match(nullDau, /DAU — · 신규 — · 세션 —/); // 콘솔 미집계는 0 이 아니라 —
});

test("consoleSummaryLine: 다중 리스팅 라벨 + 오래된 스냅샷 날짜 배지, 결제는 있을 때만", () => {
  const s = consoleSummaryLine(
    item(
      "Crossword Puzzle",
      consoleRow("2026-07-02", { payingUsers: 3, iapTrxAmountKrw: 9900 }),
      "웹",
    ),
    "2026-07-04",
  );
  assert.match(s, /<b>Crossword Puzzle\(웹\)<\/b>/);
  assert.match(s, /결제 3명 ₩9,900/);
  assert.match(s, /⏳2026-07-02/);
});

test("buildConsoleSection: 수집 데이터 없으면 빈 섹션", () => {
  const section = buildConsoleSection([item("Happy Farm", null)], new Date("2026-07-04T00:00:00Z"));
  assert.deepEqual(section.lines, []);
  assert.equal(section.refDate, null);
  assert.equal(section.lagDays, null);
  assert.equal(section.listings, 1);
  assert.equal(section.onRefDate, 0);
});

test("buildConsoleSection: 최신 기준일·수익 내림차순 정렬, 합계는 기준일 리스팅만", () => {
  const section = buildConsoleSection(
    [
      item("Happy Farm", consoleRow("2026-07-04", { dau: 10, iaaImpressions: 100, iaaEarningKrw: 500 })),
      item("Lucid Chess", consoleRow("2026-07-04", { dau: 20, iaaImpressions: 200, iaaEarningKrw: 2000 })),
      // 기준일보다 오래된 스냅샷 → 줄에는 남기되 합계에서 제외.
      item("Foam Party", consoleRow("2026-07-01", { dau: 99, iaaImpressions: 900, iaaEarningKrw: 9000 })),
    ],
    new Date("2026-07-04T00:00:00.000Z"),
  );

  assert.equal(section.refDate, "2026-07-04");
  assert.equal(section.lagDays, 0);
  assert.equal(section.onRefDate, 2);
  assert.match(section.lines[0], /AppsInToss 콘솔<\/b> \(기준 2026-07-04\)/);
  assert.doesNotMatch(section.lines[0], /지연/);
  assert.match(section.lines[1], /<b>Foam Party<\/b>/); // 수익 9000 = 1위
  assert.match(section.lines[2], /<b>Lucid Chess<\/b>/);
  assert.match(section.lines[3], /<b>Happy Farm<\/b>/);
  const total = section.lines[4];
  assert.match(total, /<b>합계<\/b> DAU 30 · 신규 10 · 광고 300회 ₩2,500/); // Foam Party 제외
  assert.match(total, /\(기준일 2\/3 리스팅\)/);
  assert.doesNotMatch(total, /결제/);
});

test("buildConsoleSection: GA4 기준일 대비 지연·미수집 리스팅·DAU 전부 미집계 표기", () => {
  const section = buildConsoleSection(
    [
      item("Happy Farm", consoleRow("2026-07-02", { dau: null, iapTrxAmountKrw: 5000, payingUsers: 2 })),
      item("Vocab Swipe", null),
    ],
    new Date("2026-07-04T00:00:00.000Z"),
  );

  assert.equal(section.refDate, "2026-07-02");
  assert.equal(section.lagDays, 2);
  assert.match(section.lines[0], /기준 2026-07-02, GA4 대비 2일 지연/);
  const total = section.lines[2];
  assert.match(total, /<b>합계<\/b> DAU — /); // 전부 미집계 → 0 이 아니라 —
  assert.match(total, /결제 ₩5,000/);
  assert.match(total, /\(기준일 1\/2 리스팅\)/);
  assert.match(section.lines[3], /⚠️ 수집 없음: Vocab Swipe/);
});
