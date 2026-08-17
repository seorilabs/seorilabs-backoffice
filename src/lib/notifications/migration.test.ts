import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const sql = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20_discord_operational_notifications/migration.sql",
  ),
  "utf8",
);

test("Telegram outbox migration은 event와 목적지 delivery를 분리하고 상태를 보존한다", () => {
  assert.match(sql, /CREATE TABLE `notification_event`/);
  assert.match(sql, /CREATE TABLE `notification_delivery`/);
  assert.match(
    sql,
    /UNIQUE INDEX `notification_delivery_eventId_provider_destinationKey_key`\(`eventId`, `provider`, `destinationKey`\)/,
  );
  assert.match(
    sql,
    /`status`, `attempts`, `nextAttemptAt`, `lastError`, `sentAt`, `createdAt`, `updatedAt`\s+FROM `telegram_notification`/s,
  );
  assert.ok(
    sql.indexOf("INSERT INTO `notification_delivery`") <
      sql.indexOf("DROP TABLE `telegram_notification`"),
  );
});
