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

const discordSql = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/21_discord_command_incidents/migration.sql",
  ),
  "utf8",
);

const storeReviewSql = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/22_store_review_notifications/migration.sql",
  ),
  "utf8",
);

const dropTelegramSql = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/23_drop_telegram_legacy/migration.sql",
  ),
  "utf8",
);

const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

test("과거 outbox 이관 migration은 event와 목적지 delivery를 분리하고 상태를 보존한다", () => {
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

test("Discord 이관 migration은 기존 이벤트 slug를 실제 App FK로 변환해 milestone을 선반영한다", () => {
  assert.match(discordSql, /INNER JOIN `app` ON `app`\.`slug` = `candidate_event`\.`appId`/);
  assert.match(discordSql, /AND NOT EXISTS \(/);
  assert.match(
    discordSql,
    /`earlier_event`\.`occurredAt` < `candidate_event`\.`occurredAt`[\s\S]*`earlier_event`\.`eventId` < `candidate_event`\.`eventId`/,
  );
  assert.doesNotMatch(discordSql, /GROUP_CONCAT/i);
});

test("마켓 리뷰 migration은 앱·스토어 기준선과 리뷰 fingerprint를 분리한다", () => {
  assert.match(storeReviewSql, /'STORE_REVIEW'/);
  assert.match(storeReviewSql, /CREATE TABLE `store_review_sync`/);
  assert.match(storeReviewSql, /CREATE TABLE `store_review_observation`/);
  assert.match(
    storeReviewSql,
    /UNIQUE INDEX `store_review_observation_appId_store_externalReviewId_key`/,
  );
  const observation = schema.match(/model StoreReviewObservation \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.doesNotMatch(observation, /\b(?:author|nickname|title|body)\b/i);
});

test("Telegram 정리 migration은 배달행을 먼저 비운 뒤 provider enum을 좁히고 이력 테이블을 지운다", () => {
  assert.ok(
    dropTelegramSql.indexOf("DELETE FROM `notification_delivery` WHERE `provider` = 'TELEGRAM'") <
      dropTelegramSql.indexOf("MODIFY `provider` ENUM('DISCORD') NOT NULL"),
  );
  assert.match(dropTelegramSql, /DROP TABLE IF EXISTS `telegram_turn`/);
  assert.match(dropTelegramSql, /DROP TABLE IF EXISTS `telegram_pending`/);
  assert.doesNotMatch(dropTelegramSql, /DROP TABLE `notification_event`/);
});

test("schema는 Telegram provider와 이력 모델을 더 이상 선언하지 않는다", () => {
  const provider = schema.match(/enum NotificationProvider \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(provider, /DISCORD/);
  assert.doesNotMatch(provider, /TELEGRAM/);
  assert.doesNotMatch(schema, /model Telegram\w+/);
});
