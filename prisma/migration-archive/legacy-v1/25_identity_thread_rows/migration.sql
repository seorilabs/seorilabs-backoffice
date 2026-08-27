-- 신규 계정 요약 카드에 건별 행 데이터를 쓰레드 댓글로 덧붙인다.
-- 카드는 그대로 갱신되고, 계정 하나가 댓글 하나가 된다.
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
        'IDENTITY_SUMMARY',
        'IDENTITY_ROW'
    ) NOT NULL;
