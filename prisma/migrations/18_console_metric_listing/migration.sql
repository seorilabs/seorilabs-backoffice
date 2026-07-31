-- 콘솔 미니앱 리스팅 분리: 한 App(=repo)이 콘솔에 여러 미니앱으로 등록될 수 있어(예:
-- crossword-puzzle 웹 36555 + 네이티브 게임 56407) 지표 유니크 키를 (appId, date) → (appId,
-- miniAppId, date) 로 확장한다. 기존 row 는 단일 리스팅이므로 slug 기준으로 기존 miniAppId 를
-- backfill 한다(DB App.aitMiniAppId 값 의존 없이 결정적으로).

-- 1) miniAppId 컬럼 추가(우선 NULL 허용, backfill 후 NOT NULL 승격)
ALTER TABLE `app_console_metric_daily` ADD COLUMN `miniAppId` INTEGER NULL;

-- 2) 기존 row backfill (수집 대상 slug → 당시 단일 콘솔 miniAppId).
--    crossword-puzzle 기존분은 전부 웹(36555) 시절 데이터다.
UPDATE `app_console_metric_daily` m
  JOIN `app` a ON m.`appId` = a.`id`
  SET m.`miniAppId` = CASE a.`slug`
    WHEN 'happy-farm'         THEN 31877
    WHEN 'match-picture-app'  THEN 32325
    WHEN 'lucid-chess'        THEN 34107
    WHEN 'dpti-app'           THEN 34639
    WHEN 'periodic-table-app' THEN 36076
    WHEN 'crossword-puzzle'   THEN 36555
    WHEN 'vocab-swipe'        THEN 36976
    WHEN 'lucid-reversi'      THEN 44056
    WHEN 'foam-party'         THEN 50736
    WHEN 'trait-test-hub'     THEN 54985
    ELSE m.`miniAppId`
  END
  WHERE m.`miniAppId` IS NULL;

-- 3) 매핑 밖 잔여(위 10 slug 외)가 있으면 App.aitMiniAppId 로 보조 backfill.
UPDATE `app_console_metric_daily` m
  JOIN `app` a ON m.`appId` = a.`id`
  SET m.`miniAppId` = a.`aitMiniAppId`
  WHERE m.`miniAppId` IS NULL AND a.`aitMiniAppId` IS NOT NULL;

-- 4) NOT NULL 승격(전 row 가 backfill 됐다는 전제 — 위 두 단계로 전 대상 커버).
ALTER TABLE `app_console_metric_daily` MODIFY COLUMN `miniAppId` INTEGER NOT NULL;

-- 5) dau/newUsers nullable 로 변경(콘솔 미집계 표현). 기존 0 값은 그대로 유지된다.
ALTER TABLE `app_console_metric_daily` MODIFY COLUMN `dau` INTEGER NULL;
ALTER TABLE `app_console_metric_daily` MODIFY COLUMN `newUsers` INTEGER NULL;

-- 6) 유니크 키 재구성 (appId, date) → (appId, miniAppId, date)
ALTER TABLE `app_console_metric_daily` DROP INDEX `app_console_metric_daily_appId_date_key`;
ALTER TABLE `app_console_metric_daily`
  ADD UNIQUE INDEX `app_console_metric_daily_appId_miniAppId_date_key` (`appId`, `miniAppId`, `date`);
