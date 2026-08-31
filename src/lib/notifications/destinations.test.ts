import assert from "node:assert/strict";
import test from "node:test";
import {
  discordDestinationOrFallback,
  discordDestinations,
} from "@/lib/notifications/destinations";
import { DISCORD_CARD_CHANNEL_KEYS } from "@/lib/discord/roles";

function withChannel(key: string, value: string | undefined, run: () => void): void {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

test("생산자에 채널 ID가 없어도 논리 Discord 목적지를 기록한다", () => {
  const keys = ["DISCORD_CHANNEL_METRICS_DAILY_ID", "DISCORD_CHANNEL_OPS_ALERTS_ID", "DISCORD_CHANNEL_USER_REVIEWS_ID"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.deepEqual(discordDestinations(["metrics-daily", "ops-alerts", "user-reviews"]), [
      { provider: "DISCORD", key: "metrics-daily" },
      { provider: "DISCORD", key: "ops-alerts" },
      { provider: "DISCORD", key: "user-reviews" },
    ]);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("전용 채널이 설정돼 있으면 그쪽으로 보낸다", () => {
  withChannel("DISCORD_CHANNEL_GITHUB_ISSUES_ID", "123456789012345678", () => {
    assert.deepEqual(discordDestinationOrFallback("github-issues", "backoffice"), [
      { provider: "DISCORD", key: "github-issues" },
    ]);
  });
});

test("전용 채널 미설정이면 기존 채널로 폴백해 알림이 끊기지 않는다", () => {
  // 채널 ID 봉인 전에 배포해도 dead letter 로 사라지지 않아야 한다.
  for (const value of [undefined, "", "   "]) {
    withChannel("DISCORD_CHANNEL_GITHUB_ISSUES_ID", value, () => {
      assert.deepEqual(discordDestinationOrFallback("github-issues", "backoffice"), [
        { provider: "DISCORD", key: "backoffice" },
      ]);
    });
  }
});

test("github-issues 는 버튼 카드 채널이 아니다", () => {
  // 전체 이슈가 흐르는 곳이라 버튼을 놓지 않는다. 카드 채널 목록에 들어가면
  // 인터랙션 허용 범위가 불필요하게 넓어진다.
  assert.equal(DISCORD_CARD_CHANNEL_KEYS.includes("github-issues" as never), false);
});
