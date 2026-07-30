import assert from "node:assert/strict";
import test from "node:test";
import { buildAppReportMd, summaryLine, type MetricRow } from "@/lib/core/analytics-report";

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
