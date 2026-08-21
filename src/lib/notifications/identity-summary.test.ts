import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  formatElapsed,
  identityRowDedupeKey,
  identityRowRanges,
  identityRowText,
  identitySummaryDedupeKey,
  identitySummaryText,
  identityThreadName,
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
      { occurredAt: new Date("2026-08-19T07:44:00Z"), attributes: { authType: "apps_in_toss", referrer: "DEFAULT" } },
      { occurredAt: new Date("2026-08-19T07:36:00Z"), attributes: { authType: "firebase", anonymous: true } },
      { occurredAt: new Date("2026-08-19T02:10:00Z"), attributes: { authType: "firebase", anonymous: true } },
    ],
  });
  assert.ok(facts);
  assert.equal(facts.todayTotal, 3);
  assert.equal(facts.anonymous, 2);
  assert.deepEqual(facts.authTypes, [["firebase", 2], ["apps_in_toss", 1]]);
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
    authTypes: [["firebase", 10], ["apps_in_toss", 2]],
    referrers: [["DEFAULT", 11], ["SANDBOX", 1]],
  });
  assert.match(text, /오늘 신규 계정 12명/);
  assert.match(text, /직전 간격 8분/);
  assert.match(text, /누적: 639번째 계정/);
  assert.match(text, /인증: firebase 10 · apps_in_toss 2/);
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

const summarySource = readFileSync(join(process.cwd(), "src/lib/notifications/identity-summary.ts"), "utf8");
const outboxSource = readFileSync(join(process.cwd(), "src/lib/notifications/outbox.ts"), "utf8");
const deploySource = readFileSync(join(process.cwd(), "src/lib/notifications/deploy.ts"), "utf8");

test("갱신 재발송은 전송 중인 delivery를 되돌리지 않는다", () => {
  assert.match(outboxSource, /status: \{ in: \["SENT", "DEAD_LETTER"\] \}/);
  assert.match(outboxSource, /providerMessageId: result\.messageId \?\? row\.providerMessageId/);
});

test("갱신 재발송은 보존기한 정리 표시를 함께 지운다", () => {
  // deletedAt이 남으면 재발송으로 생긴 새 메시지가 정리 대상에서 영구히 빠진다.
  assert.match(outboxSource, /deletedAt: null,\n\s*\},\n\s*\}\);\n\s*return result\.count;/);
});

test("요약 카드는 기존 메시지를 편집하고 삭제됐을 때만 새로 만든다", () => {
  assert.match(deploySource, /kind === "IDENTITY_SUMMARY" && providerMessageId/);
  assert.match(deploySource, /errorCode !== 10_008\) return edited/);
});

test("신규 계정 알림은 앱·KST 날짜 dedupe 키 하나로 enqueue하고 갱신 발송한다", () => {
  assert.match(
    summarySource,
    /dedupeKey: identitySummaryDedupeKey\(input\.app\.slug, facts\.dateKey\)/,
  );
  assert.match(summarySource, /kind: "IDENTITY_SUMMARY"/);
  assert.match(summarySource, /await requeueNotification\(eventId\)/);
});

test("등록된 앱의 신규 계정은 건별 카드를 만들지 않는다", () => {
  const routeSource = readFileSync(
    join(process.cwd(), "src/app/api/internal/platform/operational-events/route.ts"),
    "utf8",
  );
  assert.match(routeSource, /input\.type === "identity\.created"\s*\?\s*await recordIdentitySignup/);
  assert.match(routeSource, /if \(!milestone && !summarized\)/);
});

test("쓰레드 댓글에는 KST 시각·순번·직전 간격·인증·유입이 담긴다", () => {
  const text = identityRowText({
    ordinal: 17,
    occurredAt: new Date("2026-08-21T06:21:35Z"),
    previousAt: new Date("2026-08-21T06:17:23Z"),
    authType: "apps_in_toss",
    anonymous: false,
    referrer: "main_banner",
  });
  assert.match(text, /`#17`/);
  assert.match(text, /15:21:35/);
  assert.match(text, /직전 \+4분/);
  assert.match(text, /apps_in_toss/);
  assert.match(text, /유입 main_banner/);
  assert.doesNotMatch(text, /익명/);
});

test("쓰레드 댓글은 없는 속성을 지어내지 않는다", () => {
  const text = identityRowText({
    ordinal: 1,
    occurredAt: new Date("2026-08-20T15:02:59Z"),
    previousAt: null,
    authType: null,
    anonymous: true,
    referrer: null,
  });
  // UTC 15:02는 KST로 다음 날 00:02다. 그날의 첫 계정이라 직전 간격이 없다.
  assert.match(text, /00:02:59/);
  assert.match(text, /익명/);
  assert.doesNotMatch(text, /직전/);
  assert.doesNotMatch(text, /유입/);
});

test("쓰레드 댓글은 운영 이벤트당 하나만 남기고 쓰레드는 앱·KST 날짜로 이름 붙인다", () => {
  assert.equal(
    identityRowDedupeKey("identity_58542708455af9fd9f3d88aec5025cd8"),
    "identity-row:identity_58542708455af9fd9f3d88aec5025cd8",
  );
  assert.equal(
    identityThreadName("도마뱀 테라리움", "2026-08-21"),
    "도마뱀 테라리움 신규 계정 2026-08-21",
  );
});

test("건별 행은 카드 뒤에 enqueue돼 카드가 먼저 발송되게 한다", () => {
  // outbox는 createdAt 오름차순으로 돈다. 카드 delivery가 먼저 만들어져야
  // 댓글 차례에 쓰레드를 걸 카드 메시지가 확정돼 있다.
  const cardIndex = summarySource.indexOf('kind: "IDENTITY_SUMMARY"');
  const rowIndex = summarySource.indexOf('kind: "IDENTITY_ROW"');
  assert.ok(cardIndex >= 0 && rowIndex > cardIndex);
  assert.match(summarySource, /dedupeKey: identityRowDedupeKey\(input\.event\.eventId\)/);
});

test("하루 첫 계정만 멘션 대상으로 표시한다", () => {
  assert.match(summarySource, /first: ordinal === 1/);
});

test("행 순번은 자기 자신을 포함하고 직전 간격은 자기 자신을 뺀다", () => {
  const dayStart = new Date("2026-08-20T15:00:00Z");
  const occurredAt = new Date("2026-08-21T01:46:27Z");
  const { upTo, before } = identityRowRanges(dayStart, occurredAt);
  assert.deepEqual(upTo, { gte: dayStart, lte: occurredAt });
  assert.deepEqual(before, { gte: dayStart, lt: occurredAt });
});

test("재전송된 옛 이벤트는 그 뒤에 생긴 계정을 순번에 넣지 않는다", () => {
  // Platform 재전송의 유일한 복구 경로라 옛 이벤트가 다시 들어온다. 당일 전체를
  // 세면 그 이벤트의 순번과 직전 간격이 아니라 지금 시점의 값이 나온다.
  const dayStart = new Date("2026-08-20T15:00:00Z");
  const day = [
    new Date("2026-08-20T21:27:34Z"),
    new Date("2026-08-21T01:46:27Z"),
    new Date("2026-08-21T06:37:49Z"),
  ];
  const redelivered = day[1];
  const { upTo, before } = identityRowRanges(dayStart, redelivered);
  const ordinal = day.filter((at) => at >= upTo.gte && at <= upTo.lte).length;
  const previous = day.filter((at) => at >= before.gte && at < before.lt).at(-1) ?? null;
  assert.equal(ordinal, 2);
  assert.deepEqual(previous, day[0]);
  assert.match(identityRowText({
    ordinal,
    occurredAt: redelivered,
    previousAt: previous,
    authType: null,
    anonymous: false,
    referrer: null,
  }), /`#2` · 10:46:27 · 직전 \+4시간 19분/);
});

test("행 범위는 당일 끝이 아니라 이 이벤트 시각을 상한으로 쓴다", () => {
  assert.match(summarySource, /occurredAt: ranges\.upTo/);
  assert.match(summarySource, /occurredAt: ranges\.before/);
  assert.doesNotMatch(summarySource, /ranges\.\w+[\s\S]{0,80}dayEnd/);
});

test("행 배달은 카드 메시지에 쓰레드를 걸고 첫 댓글만 멘션한다", () => {
  assert.match(deploySource, /kind === "IDENTITY_ROW"\) return deliverIdentityRow/);
  assert.match(deploySource, /startDiscordThread\(\s*discordChannelId\(destinationKey\),\s*card\.providerMessageId/);
  assert.match(deploySource, /row\.first \? \{ alertRoleId: env\.discordRoleId\("release_ops"\) \} : \{\}/);
  // 한 건씩 쌓이는 기록이라 embed 상자 없이 본문 한 줄로 보낸다.
  assert.match(deploySource, /plain: true,/);
});

test("카드가 아직 안 나갔으면 댓글을 붙이지 않고 재시도로 넘긴다", () => {
  assert.match(deploySource, /if \(!card\?\.providerMessageId\) return \{ ok: false/);
});

test("댓글은 message ID를 남기지 않아 보존기한 정리가 쓰레드 밖에서 지우려 하지 않는다", () => {
  // 카드가 지워질 때 쓰레드와 댓글이 함께 사라진다. 채널 기준 삭제 대상이 되면 안 된다.
  assert.match(deploySource, /return sent\.ok \? \{ ok: true \} : sent;/);
});
