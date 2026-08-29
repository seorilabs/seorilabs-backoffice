-- 배포 catch-up occurrence를 exact source SHA에 결합하는 expand-only migration.
-- 기존 run은 출처를 추측하지 않고 null로 보존한다.
ALTER TABLE `control_plane_desired_state_backfill_run`
    ADD COLUMN `trigger` ENUM('HOURLY_CRON', 'DEPLOY_CATCH_UP', 'CONTROL_PLANE_API') NULL,
    ADD COLUMN `sourceSha` CHAR(40) NULL;

CREATE INDEX `cp_desired_backfill_trigger_source_started_idx`
    ON `control_plane_desired_state_backfill_run`(`trigger`, `sourceSha`, `startedAt`);
