import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(process.cwd(), "prisma/migrations/19_split_ad_metrics/migration.sql"),
  "utf8",
);

test("migration 19: 광고 지표 분리 컬럼을 비파괴 add로만 확장한다", () => {
  for (const column of [
    "adCtaUsers",
    "adCtaImpressions",
    "adCompletedUsers",
    "adCompletions",
    "networkAdUsers",
    "networkAdImpressions",
  ]) {
    assert.match(SQL, new RegExp(`ADD COLUMN \\\`${column}\\\` INTEGER NOT NULL DEFAULT 0`));
  }
  assert.doesNotMatch(SQL, /\bDROP\b|\bRENAME\b|\bCHANGE\b/i);
});
