ALTER TABLE `notification_event`
    MODIFY `kind` ENUM(
        'DEPLOY_COMPLETION',
        'DAILY_METRICS',
        'OPERATIONS_SUMMARY',
        'OPERATIONAL_EVENT',
        'OPS_ALERT',
        'EXTERNAL_FEED',
        'MILESTONE',
        'INCIDENT',
        'STORE_REVIEW',
        'IDENTITY_SUMMARY'
    ) NOT NULL;

-- 운영 이벤트 수집 이전에 이미 존재하던 Platform 계정 수. 알림 순번의 시작점이다.
ALTER TABLE `app`
    ADD COLUMN `platformUserBaseline` INTEGER NULL;
