import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  formatElapsed,
  identitySummaryDedupeKey,
  identitySummaryText,
  kstDateKey,
  summarizeIdentityEvents,
} from "@/lib/notifications/identity-summary";

const base = {
  displayName: "도마뱀 테라리움",
  dateKey: "2026-08-19",
  todayTotal: 12,
  cumulative: 639,
};

test("KST 날짜 키는 UTC 15시에 다음 날로 넘어간다", () => {
  assert.equal(kstDateKey(new Date("2026-08-19T14:59:59Z")), "2026-08-19");
  assert.equal(kstDateKey(new Date("2026-08-19T15:00:00Z")), "2026-08-20");
});

test("경과 시간은 초·분·시간 단위로 읽히게 만든다", () => {
  assert.equal(formatElapsed(45_000), "45초");
  assert.equal(formatElapsed(8 * 60_000), "8분");
  assert.equal(formatElapsed(125 * 60_000), "2시간 5분");
  assert.equal(formatElapsed(120 * 60_000), "2시간");
});

test("당일 이벤트에서 인증·익명·유입 분해와 직전 간격을 집계한다", () => {
  const facts = summarizeIdentityEvents({
    ...base,
    todayTotal: 3,
    rows: [
      { occurredAt: new Date("2026-08-19T07:44:00Z"), attributes: { authType: "ait_login", referrer: "DEFAULT" } },
      { occurredAt: new Date("2026-08-19T07:36:00Z"), attributes: { authType: "firebase", anonymous: true } },
      { occurredAt: new Date("2026-08-19T02:10:00Z"), attributes: { authType: "firebase", anonymous: true } },
    ],
  });
  assert.ok(facts);
  assert.equal(facts.todayTotal, 3);
  assert.equal(facts.anonymous, 2);
  assert.deepEqual(facts.authTypes, [["firebase", 2], ["ait_login", 1]]);
  assert.deepEqual(facts.referrers, [["DEFAULT", 1]]);
  assert.deepEqual(facts.latestAt, new Date("2026-08-19T07:44:00Z"));
  assert.deepEqual(facts.previousAt, new Date("2026-08-19T07:36:00Z"));
});

test("당일 이벤트가 없으면 알릴 요약이 없다", () => {
  assert.equal(summarizeIdentityEvents({ ...base, todayTotal: 0, rows: [] }), null);
});

test("카드에는 신규 수·최근 생성·직전 간격·누적·분해가 담긴다", () => {
  const text = identitySummaryText({
    displayName: "도마뱀 테라리움",
    dateKey: "2026-08-19",
    todayTotal: 12,
    cumulative: 639,
    latestAt: new Date("2026-08-19T07:44:00Z"),
    previousAt: new Date("2026-08-19T07:36:00Z"),
    anonymous: 2,
    authTypes: [["firebase", 10], ["ait_login", 2]],
    referrers: [["DEFAULT", 11], ["SANDBOX", 1]],
  });
  assert.match(text, /오늘 신규 계정 12명/);
  assert.match(text, /직전 간격 8분/);
  assert.match(text, /누적: 639번째 계정/);
  assert.match(text, /인증: firebase 10 · ait_login 2/);
  assert.match(text, /익명 계정: 2/);
  assert.match(text, /유입: DEFAULT 11 · SANDBOX 1/);
});

test("baseline이 없으면 누적 순번을 지어내지 않는다", () => {
  const text = identitySummaryText({
    displayName: "조물조물 만물 합치기",
    dateKey: "2026-08-19",
    todayTotal: 1,
    cumulative: null,
    latestAt: new Date("2026-08-19T07:44:00Z"),
    previousAt: null,
    anonymous: 0,
    authTypes: [["firebase_bridge", 1]],
    referrers: [],
  });
  assert.doesNotMatch(text, /누적/);
  assert.doesNotMatch(text, /직전 간격/);
  assert.doesNotMatch(text, /익명 계정/);
  assert.doesNotMatch(text, /유입/);
});

test("요약 카드는 앱·KST 날짜당 하나만 유지한다", () => {
  assert.equal(
    identitySummaryDedupeKey("lizard-tycoon", "2026-08-19"),
    "identity-daily:lizard-tycoon:2026-08-19",
  );
});

const outboxSource = readFileSync(join(process.cwd(), "src/lib/notifications/outbox.ts"), "utf8");
const deploySource = readFileSync(join(process.cwd(), "src/lib/notifications/deploy.ts"), "utf8");

test("갱신 재발송은 전송 중인 delivery를 되돌리지 않는다", () => {
  assert.match(outboxSource, /status: \{ in: \["SENT", "DEAD_LETTER"\] \}/);
  assert.match(outboxSource, /providerMessageId: result\.messageId \?\? row\.providerMessageId/);
});

test("요약 카드는 기존 메시지를 편집하고 삭제됐을 때만 새로 만든다", () => {
  assert.match(deploySource, /kind === "IDENTITY_SUMMARY" && providerMessageId/);
  assert.match(deploySource, /errorCode !== 10_008\) return edited/);
});
