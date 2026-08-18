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
  assert.match(discordSql, /INNER JOIN `app` ON `app`\.`slug` = `operational_event`\.`appId`/);
  assert.match(discordSql, /GROUP BY `app`\.`id`, `operational_event`\.`eventType`/);
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
