import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SQL = readFileSync(
  new URL(
    "../../../prisma/migration-archive/legacy-v1/33_platform_app_id_binding/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Platform app_id binding migration", () => {
  it("nullable 영속 컬럼과 유일 인덱스를 추가한다", () => {
    assert.match(SQL, /ADD COLUMN `platformAppId` VARCHAR\(191\) NULL/);
    assert.match(
      SQL,
      /CREATE UNIQUE INDEX `app_platformAppId_key` ON `app`\(`platformAppId`\)/,
    );
  });
});
