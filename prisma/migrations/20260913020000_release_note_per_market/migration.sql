-- ReleaseNote에 market 컬럼을 도입하고 per-market unique 를 추가한다 (expand 단계).
--
-- 배경:
--   출시노트는 Google Play / App Store / AppsInToss 3 마켓에 동시에 게시되지만, 변경
--   중 일부는 마켓 한정이다. 한 row 가 모든 마켓 본문을 공유하면 AppsInToss 한정
--   변경이 Google Play/App Store 본문에 노출되는 결함이 있어 row 단위로 마켓을 나눈다.
--
-- 본 migration 은 expand 단계로 제한한다 (기존 row 보존, 기존 unique 보존):
--   1) market 컬럼 nullable 로 추가 — 기존 row 는 NULL 상태로 두어 writer 호환을 유지
--   2) 새 unique (repoFullName, version, market) 추가 — 신규 3-row 생성 경로가 활성화
--      되어도 MySQL 은 NULL 값을 unique 에서 중복 허용하므로 기존 row 와 충돌하지 않음
--
-- 멱등(idempotent): 운영 환경에서 사전에 적용된 케이스가 있어 IF NOT EXISTS 가드를 건다.
-- Prisma 의 expand-only gate 가 만족하는 범위(ALTER ADD + ADD CONSTRAINT) 안에서 처리한다.
--
-- Contract 단계(legacy NULL row 제거, market NOT NULL, 옛 unique 제거)는 별도 PR +
-- approvedContractMigrations 등록으로 분리한다. 사유: 기존 코드가 NULL market row 를
-- 읽어 deploy 워크플로 자산을 만들던 경로가 있어 destructive 변경은 코드 제거 이후에
-- 안전하게 들어갈 수 있다.

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
