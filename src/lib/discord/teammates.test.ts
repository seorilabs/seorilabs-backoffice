import assert from "node:assert/strict";
import test from "node:test";
import { DISCORD_CARD_CHANNEL_KEYS } from "@/lib/discord/roles";
import {
  configuredTeammates,
  isNeglectedApp,
  isTeammateKey,
  portfolioLines,
  shouldHandleTeammateMention,
  stripMentionTags,
  TEAMMATE_KEYS,
  TEAMMATES,
} from "@/lib/discord/teammates";

test("담당제 팀원은 오너 5명 + 운영 총괄 1명이고 권한 번들이 정의돼 있다", () => {
  assert.deepEqual(TEAMMATE_KEYS, ["noeul", "iseul", "baram", "saebyeok", "maru", "seori"]);
  const owners = TEAMMATE_KEYS.filter((key) => TEAMMATES[key].kind === "owner");
  assert.equal(owners.length, 5);
  for (const key of TEAMMATE_KEYS) {
    const meta = TEAMMATES[key];
    assert.equal(meta.key, key);
    assert.ok(meta.ko.length > 0);
    assert.ok(meta.capabilities.length > 0);
    // 배포 트리거·파괴 작업은 어떤 팀원에게도 없다(사람 게이트 유지).
    assert.ok(!meta.capabilities.includes("release"), `${key} 에 배포 권한이 있다`);
  }
});

test("초안을 만드는 팀원의 보고 채널은 전부 카드 버튼 allowlist 채널이다", () => {
  // 초안 confirm 카드에는 버튼이 실리므로, 버튼 allowlist 밖 채널로 보고하는
  // 팀원은 초안을 만들 수 없어야 한다.
  for (const key of TEAMMATE_KEYS) {
    const meta = TEAMMATES[key];
    if (!meta.draftsEnabled) continue;
    assert.ok(
      (DISCORD_CARD_CHANNEL_KEYS as readonly string[]).includes(meta.channelKey),
      `${key} 채널 ${meta.channelKey} 이 카드 채널이 아니다`,
    );
  }
});

test("운영 총괄(서리)은 통합 채널로 보고하고 이슈 초안을 만들지 않는다", () => {
  assert.equal(TEAMMATES.seori.kind, "chief");
  assert.equal(TEAMMATES.seori.channelKey, "app-ops");
  assert.equal(TEAMMATES.seori.draftsEnabled, false);
});

test("isTeammateKey 는 구 직군 키와 사람 역할을 거른다", () => {
  assert.ok(isTeammateKey("noeul"));
  assert.ok(isTeammateKey("seori"));
  assert.ok(!isTeammateKey("data")); // 담당제 전환 전 직군 키
  assert.ok(!isTeammateKey("operator"));
  assert.ok(!isTeammateKey(""));
});

test("포트폴리오 줄 목록은 앱과 단계를 담고 빈 배분을 드러낸다", () => {
  const lines = portfolioLines([
    { id: "1", slug: "happy-farm", displayName: "해피팜", repoFullName: "seorilabs/happy-farm", currentStage: "LIVEOPS", status: "ACTIVE" },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /해피팜 \(happy-farm\)/);
  assert.ok(!lines[0].includes("방치"));
  assert.deepEqual(portfolioLines([]), ["- (배분된 앱 없음)"]);
});

test("봇이 보낸 메시지와 다른 길드 메시지는 응답 대상이 아니다", () => {
  const base = {
    id: "m1",
    guild_id: "g1",
    channel_id: "c1",
    content: "<@bot1> 안녕",
    author: { id: "u1", bot: false },
    mentions: [{ id: "bot1" }],
  };
  assert.ok(shouldHandleTeammateMention(base, "bot1", "g1"));
  assert.ok(!shouldHandleTeammateMention({ ...base, author: { id: "u2", bot: true } }, "bot1", "g1"));
  assert.ok(!shouldHandleTeammateMention({ ...base, guild_id: "g2" }, "bot1", "g1"));
  assert.ok(!shouldHandleTeammateMention({ ...base, mentions: [{ id: "other" }] }, "bot1", "g1"));
  assert.ok(!shouldHandleTeammateMention({ ...base, mentions: [] }, "bot1", "g1"));
  assert.ok(!shouldHandleTeammateMention(base, "", "g1"));
  assert.ok(!shouldHandleTeammateMention({ ...base, id: undefined }, "bot1", "g1"));
});

test("멘션 태그를 벗겨 사용자 발화만 남긴다", () => {
  assert.equal(stripMentionTags("<@bot1> 이번 주 지표 어때?", "bot1"), "이번 주 지표 어때?");
  assert.equal(stripMentionTags("<@!bot1>  상태  보고", "bot1"), "상태 보고");
  assert.equal(stripMentionTags("<@bot1>", "bot1"), "");
});

test("기능 플래그가 꺼져 있으면 설정된 팀원이 없다", () => {
  const original = process.env.FEATURE_DISCORD_TEAMMATES;
  delete process.env.FEATURE_DISCORD_TEAMMATES;
  try {
    assert.deepEqual(configuredTeammates(), []);
  } finally {
    if (original !== undefined) process.env.FEATURE_DISCORD_TEAMMATES = original;
  }
});

test("플래그가 켜지면 자격증명이 주입된 팀원만 활성화된다", () => {
  const saved = {
    flag: process.env.FEATURE_DISCORD_TEAMMATES,
    appId: process.env.DISCORD_TEAMMATE_NOEUL_APPLICATION_ID,
    token: process.env.DISCORD_TEAMMATE_NOEUL_BOT_TOKEN,
  };
  process.env.FEATURE_DISCORD_TEAMMATES = "true";
  process.env.DISCORD_TEAMMATE_NOEUL_APPLICATION_ID = "app";
  process.env.DISCORD_TEAMMATE_NOEUL_BOT_TOKEN = "token";
  try {
    const keys = configuredTeammates().map((meta) => meta.key);
    assert.ok(keys.includes("noeul"));
    assert.ok(!keys.includes("maru"));
  } finally {
    if (saved.flag === undefined) delete process.env.FEATURE_DISCORD_TEAMMATES;
    else process.env.FEATURE_DISCORD_TEAMMATES = saved.flag;
    if (saved.appId === undefined) delete process.env.DISCORD_TEAMMATE_NOEUL_APPLICATION_ID;
    else process.env.DISCORD_TEAMMATE_NOEUL_APPLICATION_ID = saved.appId;
    if (saved.token === undefined) delete process.env.DISCORD_TEAMMATE_NOEUL_BOT_TOKEN;
    else process.env.DISCORD_TEAMMATE_NOEUL_BOT_TOKEN = saved.token;
  }
});

test("방치(PAUSED) 앱은 포트폴리오에 운영 강도가 드러난다", () => {
  // 론칭 후 방치: 지표 수집은 계속하되 순찰은 주요 발견만 올린다.
  const paused = {
    id: "2",
    slug: "vocab-swipe",
    displayName: "보캡스와이프",
    repoFullName: "seorilabs/vocab-swipe",
    currentStage: "LIVEOPS",
    status: "PAUSED",
  };
  assert.ok(isNeglectedApp(paused));
  assert.ok(!isNeglectedApp({ status: "ACTIVE" }));
  assert.match(portfolioLines([paused])[0], /방치\(주요 이슈만 대응\)/);
});
