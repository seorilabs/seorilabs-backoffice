-- AlterTable: 플랫폼별 DAU 전용 컬럼(국가/기기/OS 분해는 raw JSON 에 저장)
ALTER TABLE `app_metric_daily`
    ADD COLUMN `dauAndroid` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `dauIos` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `dauWeb` INTEGER NOT NULL DEFAULT 0;
