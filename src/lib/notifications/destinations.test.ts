import assert from "node:assert/strict";
import test from "node:test";
import { configuredDestinations } from "@/lib/notifications/destinations";

const keys = [
  "FEATURE_TELEGRAM_ENABLED",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "DISCORD_METRICS_WEBHOOK_URL",
] as const;

test("Telegram과 Discord 목적지는 서로 독립적으로 구성된다", () => {
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.FEATURE_TELEGRAM_ENABLED = "true";
    process.env.TELEGRAM_BOT_TOKEN = "telegram-test-token";
    process.env.TELEGRAM_CHAT_ID = "1234";
    process.env.DISCORD_METRICS_WEBHOOK_URL =
      "https://discord.com/api/webhooks/1234567890/test_token";

    assert.deepEqual(configuredDestinations(["telegram", "metrics"]), [
      { provider: "TELEGRAM", key: "default" },
      { provider: "DISCORD", key: "metrics" },
    ]);

    delete process.env.DISCORD_METRICS_WEBHOOK_URL;
    assert.deepEqual(configuredDestinations(["telegram", "metrics"]), [
      { provider: "TELEGRAM", key: "default" },
    ]);

    process.env.DISCORD_METRICS_WEBHOOK_URL =
      "https://discord.com/api/webhooks/1234567890/test_token";
    delete process.env.TELEGRAM_BOT_TOKEN;
    assert.deepEqual(configuredDestinations(["telegram", "metrics"]), [
      { provider: "DISCORD", key: "metrics" },
    ]);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
