import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// migration 13(컨텐츠 지표 통합)의 인덱스 교체 순서 회귀 방지. app_content_metric_daily 의
// 기존 (appId,date) 유니크 인덱스는 appId 외래키를 백업하는 유일한 인덱스라, 새 (appId,
// date,market) 유니크 인덱스보다 먼저 DROP 하면 MySQL(InnoDB)이 errno 1553 로 거부한다
// → migrate 실패 → 배포 실패. 반드시 "새 인덱스 생성 후 기존 인덱스 드롭" 순서여야 한다.

const SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migration-archive/legacy-v1/13_unified_content_metrics/migration.sql",
  ),
  "utf8",
);

test("migration 13: market 추가 → 새 유니크 생성 → 기존 유니크 드롭 순서(FK 백업 인덱스 보존)", () => {
  const addCol = SQL.indexOf("ADD COLUMN `market`");
  const createIdx = SQL.indexOf("CREATE UNIQUE INDEX `app_content_metric_daily_appId_date_market_key`");
  const dropIdx = SQL.indexOf("DROP INDEX `app_content_metric_daily_appId_date_key`");

  assert.ok(addCol >= 0, "market 컬럼 추가 DDL 존재");
  assert.ok(createIdx >= 0, "새 (appId,date,market) 유니크 인덱스 생성 DDL 존재");
  assert.ok(dropIdx >= 0, "기존 (appId,date) 유니크 인덱스 드롭 DDL 존재");

  // 새 유니크 인덱스(appId 선두 → FK 백업 가능)를 먼저 만든 뒤 기존 인덱스를 드롭해야
  // 마이그레이션 전 과정에서 appId FK 를 백업하는 인덱스가 끊기지 않는다.
  assert.ok(createIdx < dropIdx, "새 유니크 인덱스 생성이 기존 인덱스 DROP 보다 먼저여야 함");
  // 컬럼이 있어야 새 인덱스를 만들 수 있으므로 ADD COLUMN 이 선행.
  assert.ok(addCol < createIdx, "market 컬럼 추가가 새 인덱스 생성보다 먼저여야 함");
});
