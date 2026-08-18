import assert from "node:assert/strict";
import test from "node:test";
import { DISCORD_DESTINATIONS } from "@/lib/notifications/destinations";
import {
  commandRetentionWhere,
  notificationRetentionWhere,
} from "@/lib/notifications/retention";

test("보존 정리는 DB가 추적한 30일 초과 Discord Bot 메시지만 선택한다", () => {
  const cutoff = new Date("2026-07-19T00:00:00Z");
  assert.deepEqual(notificationRetentionWhere(cutoff, ["active-incident-message"]), {
    provider: "DISCORD",
    status: "SENT",
    deletedAt: null,
    sentAt: { lt: cutoff },
    providerMessageId: { not: null, notIn: ["active-incident-message"] },
  });
});

test("종료된 명령만 정리하며 활성 장애 카드와 game-factory 채널은 보호한다", () => {
  const cutoff = new Date("2026-07-19T00:00:00Z");
  assert.deepEqual(commandRetentionWhere(cutoff, ["active-incident-message"]), {
    status: { in: ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"] },
    completedAt: { lt: cutoff },
    messageId: { not: null, notIn: ["active-incident-message"] },
  });
  assert.equal(DISCORD_DESTINATIONS.includes("game-factory-builds" as never), false);
});
