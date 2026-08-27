-- 컨텐츠 세부 지표 통합: 게임별 bespoke 테이블(happy_farm_* / foam 4종 / crossword)을
-- 제거하고 모든 게임을 범용 스펙 스냅샷(app_content_metric_daily)으로 일원화한다.
-- 스냅샷에 market 차원을 추가(마켓별 + 통합 'all' 행). 기존 지표 테이블은 매일 BigQuery
-- 재집계 캐시라 drop 후 다음 수집(app-content-collect)에서 재생성된다(윈도우 밖 과거만 손실).

-- AlterTable: app_content_metric_daily 에 market 차원 추가(마켓 미선언 스펙은 'all' 단일 행)
ALTER TABLE `app_content_metric_daily`
    ADD COLUMN `market` VARCHAR(191) NOT NULL DEFAULT 'all';

-- 유니크 키를 (appId, date) → (appId, date, market) 로 교체.
-- 순서 주의: 기존 (appId, date) 유니크 인덱스가 appId 외래키(app_content_metric_daily_appId_fkey)를
-- 백업하는 유일한 인덱스라, 먼저 DROP 하면 MySQL(InnoDB)이 거부한다(errno 1553). 새 (appId, date,
-- market) 유니크 인덱스를 먼저 만들어(appId 가 선두라 FK 를 백업 가능) 그 다음 기존 인덱스를 드롭한다.
CREATE UNIQUE INDEX `app_content_metric_daily_appId_date_market_key`
    ON `app_content_metric_daily`(`appId`, `date`, `market`);
DROP INDEX `app_content_metric_daily_appId_date_key` ON `app_content_metric_daily`;

-- DropTable: crossword 전용 표(범용 스냅샷으로 이관)
DROP TABLE IF EXISTS `crossword_metric_daily`;

-- DropTable: foam-party 전용 4종(범용 스냅샷으로 이관)
DROP TABLE IF EXISTS `app_level_metric_daily`;
DROP TABLE IF EXISTS `app_monetization_daily`;
DROP TABLE IF EXISTS `app_mission_metric_daily`;
DROP TABLE IF EXISTS `app_economy_metric_daily`;

-- DropTable: happy-farm 전용 4종. 스키마에만 있고 대응 마이그레이션이 없던 드리프트 테이블 —
-- 존재하는 환경(db push 등)에서만 정리되고, 없으면 무시된다(IF EXISTS).
DROP TABLE IF EXISTS `happy_farm_crop_daily`;
DROP TABLE IF EXISTS `happy_farm_area_daily`;
DROP TABLE IF EXISTS `happy_farm_funnel_daily`;
DROP TABLE IF EXISTS `happy_farm_ad_placement_daily`;
