import assert from "node:assert/strict";
import test from "node:test";
import {
  fallbackStandupLine,
  isKstMonday,
  kstYesterdayWindow,
  renderWeeklySummary,
  standupDedupeKey,
} from "@/lib/discord/teammate-standup";

test("스탠드업 dedupe 키는 KST 날짜 기준이라 하루 1회를 보장한다", () => {
  // 16:00Z 는 KST 다음날 01:00 — UTC 날짜로 만들면 CronJob 재발화가 이중 실행된다.
  assert.equal(standupDedupeKey(new Date("2026-08-25T16:00:00Z")), "standup:20260826");
  assert.equal(standupDedupeKey(new Date("2026-08-25T10:00:00Z")), "standup:20260825");
});

test("어제 창은 KST 자정 경계로 계산한다", () => {
  // 08-26 08:00 KST(= 08-25 23:00Z) 실행 → 어제 = KST 08-25 [00:00, 24:00).
  const { start, end } = kstYesterdayWindow(new Date("2026-08-25T23:00:00Z"));
  assert.equal(start.toISOString(), "2026-08-24T15:00:00.000Z"); // KST 08-25 00:00
  assert.equal(end.toISOString(), "2026-08-25T15:00:00.000Z"); // KST 08-26 00:00
});

test("KST 월요일 판정은 UTC 요일이 아니라 KST 기준이다", () => {
  // 2026-08-30(일) 23:00Z = KST 2026-08-31(월) 08:00 → 월요일.
  assert.ok(isKstMonday(new Date("2026-08-30T23:00:00Z")));
  assert.ok(!isKstMonday(new Date("2026-08-25T23:00:00Z"))); // KST 수요일
});

test("폴백 라인은 어제 원장 수치와 오늘 계획을 담는다", () => {
  const line = fallbackStandupLine({
    patrolFindings: 3,
    autoRegistered: 1,
    drafted: 2,
    mentions: 4,
    failed: 0,
    portfolio: [
      { slug: "happy-farm", stage: "LIVEOPS" },
      { slug: "jomul", stage: "DEVELOPMENT" },
    ],
  });
  assert.match(line, /발견 3건/);
  assert.match(line, /등록 1건/);
  assert.match(line, /멘션 4건/);
  assert.match(line, /앱 2개/);
});

test("주간 요약은 팀원별 활동·모델·비용과 채택률을 담는다", () => {
  const summary = renderWeeklySummary({
    perTeammate: [
      {
        key: "noeul",
        findings: 8,
        autoRegistered: 2,
        manualRegistered: 1,
        drafted: 3,
        deduped: 2,
        mentions: 5,
        costUsd: 1.234,
        models: new Set(["claude-opus-5"]),
      },
    ],
    notPlannedLine: "자동 등록 채택률: 14일간 6건 중 NOT_PLANNED 1건 (17%)",
  });
  assert.match(summary, /주간 팀원 활동·모델 비교/);
  assert.match(summary, /노을 \[claude-opus-5\]/);
  assert.match(summary, /자동등록 2/);
  assert.match(summary, /비용 \$1\.23/);
  assert.match(summary, /NOT_PLANNED 1건/);
});
