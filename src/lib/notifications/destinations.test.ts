import assert from "node:assert/strict";
import test from "node:test";
import { discordDestinations } from "@/lib/notifications/destinations";

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
