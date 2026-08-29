-- backfill 단계: 컨텐츠 지표의 마켓 표기를 정규 어휘로 통일한다.
--
-- 스펙이 레포 manifest 와 백오피스 내장 레지스트리 두 곳에서 오다 보니 같은 마켓이
-- 여러 표기로 쌓였다(2026-08-30 실측: crossword 하이픈, happy-farm 밑줄, foam·slot
-- 플랫폼 어휘). 수집 경계는 normalizeContentMarket 이 이미 접고 있고, 이 migration 은
-- 그 이전에 쌓인 행을 같은 규칙으로 맞춘다.
--
-- `web` 은 AIT 서면인지 독립 웹인지 문자열만으로 알 수 없어 접지 않는다. 의도를 아는
-- 스펙이 정규 키를 선언하는 쪽으로 처리한다.
--
-- 이 migration 은 expand-only 계약의 예외다. approvedContractMigrations 에 이름·checksum·
-- 사유가 등록돼야 게이트를 통과한다.
--
-- 각 UPDATE 는 대상 키 행이 이미 있으면 건드리지 않는다(appId_date_market unique 충돌 방지).
-- 실측상 한 앱이 두 표기를 동시에 갖는 경우는 없지만, 있으면 조용히 실패하는 대신 남긴다.

UPDATE `app_content_metric_daily` AS t
SET t.`market` = 'ait'
WHERE t.`market` IN ('apps-in-toss', 'apps_in_toss', 'appsintoss', 'toss')
  AND NOT EXISTS (
    SELECT 1 FROM (SELECT * FROM `app_content_metric_daily`) AS x
    WHERE x.`appId` = t.`appId` AND x.`date` = t.`date` AND x.`market` = 'ait'
  );

UPDATE `app_content_metric_daily` AS t
SET t.`market` = 'play'
WHERE t.`market` IN ('google-play', 'google_play', 'googleplay', 'android')
  AND NOT EXISTS (
    SELECT 1 FROM (SELECT * FROM `app_content_metric_daily`) AS x
    WHERE x.`appId` = t.`appId` AND x.`date` = t.`date` AND x.`market` = 'play'
  );

UPDATE `app_content_metric_daily` AS t
SET t.`market` = 'appstore'
WHERE t.`market` IN ('app-store', 'app_store', 'ios')
  AND NOT EXISTS (
    SELECT 1 FROM (SELECT * FROM `app_content_metric_daily`) AS x
    WHERE x.`appId` = t.`appId` AND x.`date` = t.`date` AND x.`market` = 'appstore'
  );
