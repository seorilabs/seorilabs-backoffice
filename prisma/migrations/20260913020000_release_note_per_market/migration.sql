-- ReleaseNote에 market 컬럼을 도입하고 per-market unique 로 분리한다.
--
-- 배경:
--   출시노트는 Google Play / App Store / AppsInToss 3 마켓에 동시에 게시되지만, 변경
--   중 일부는 마켓 한정이다. 한 row 가 모든 마켓 본문을 공유하면 AppsInToss 한정
--   변경이 Google Play/App Store 본문에 노출되는 결함이 있어 row 단위로 마켓을 나눈다.
--
-- 본 migration 은 expand + contract 동시 수행으로 모드 (기존 row 보존, 기존 unique
-- drop 까지 한 migration 으로 묶음):
--   1) market 컬럼 nullable 로 추가 — 기존 row 는 NULL 상태로 두어 writer 호환 유지
--   2) 새 unique (repoFullName, version, market) 추가 — 마켓별 row 가 이 키로 충돌 방지
--   3) 옛 unique (repoFullName, version) drop — 새 코드가 같은 (repo, version) 으로
--      마켓 3개 row 를 upsert 할 때 옛 키가 막아버리므로 같이 제거해야 한다.
--
-- 멱등(idempotent): 운영 환경에서 사전에 적용된 케이스가 있어 IF NOT EXISTS 가드를 건다.
-- (3) 의 옛 unique drop 은 expand-only 게이트의 DROP 금지에 걸리므로
-- approvedContractMigrations 항목으로 별도 승인 받는다 (migration-history.json).
--
-- contract 단계 후속: NULL market row 정리, market NOT NULL 강화는 별도 PR.

-- 1) market 컬럼 추가 — 이미 있으면 스킵
SET @add_market = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'release_note'
     AND COLUMN_NAME = 'market') = 0,
  'ALTER TABLE `release_note` ADD COLUMN `market` ENUM(''PLAY'', ''APPSTORE'', ''AIT'', ''WEB'') NULL',
  'DO 0'
);
PREPARE stmt FROM @add_market;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2) 새 unique 추가 — 이미 있으면 스킵
SET @add_unique = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'release_note'
     AND INDEX_NAME = 'release_note_repoFullName_version_market_key') = 0,
  'ALTER TABLE `release_note` ADD CONSTRAINT `release_note_repoFullName_version_market_key` UNIQUE (`repoFullName`, `version`, `market`)',
  'DO 0'
);
PREPARE stmt FROM @add_unique;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3) 옛 unique (repoFullName, version) drop — 이미 drop 됐으면 스킵. 이 DROP 은
-- expand-only gate 의 DROP 금지에 해당하므로 approvedContractMigrations 에 등록한다.
SET @drop_old_unique = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'release_note'
     AND INDEX_NAME = 'release_note_repoFullName_version_key') > 0,
  'ALTER TABLE `release_note` DROP INDEX `release_note_repoFullName_version_key`',
  'DO 0'
);
PREPARE stmt FROM @drop_old_unique;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
