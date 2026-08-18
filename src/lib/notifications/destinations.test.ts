import assert from "node:assert/strict";
import test from "node:test";
import { configuredDestinations } from "@/lib/notifications/destinations";

test("설정된 Discord 채널만 목적지로 선택한다", () => {
  const keys = ["DISCORD_CHANNEL_METRICS_DAILY_ID", "DISCORD_CHANNEL_OPS_ALERTS_ID"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.DISCORD_CHANNEL_METRICS_DAILY_ID = "1538852842146631701";
    delete process.env.DISCORD_CHANNEL_OPS_ALERTS_ID;
    assert.deepEqual(configuredDestinations(["metrics-daily", "ops-alerts"]), [
      { provider: "DISCORD", key: "metrics-daily" },
    ]);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
