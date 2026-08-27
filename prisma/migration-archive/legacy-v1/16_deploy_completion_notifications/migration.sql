-- Xcode Cloud 실행을 ReleaseRecord 에 연결하고 Telegram 완료 알림을 outbox 로 전달한다.
ALTER TABLE `release_record`
    ADD COLUMN `externalRunId` VARCHAR(191) NULL,
    ADD COLUMN `externalBuildNumber` INTEGER NULL;

CREATE UNIQUE INDEX `release_record_externalRunId_key`
    ON `release_record`(`externalRunId`);

CREATE TABLE `telegram_notification` (
    `id` VARCHAR(191) NOT NULL,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `kind` ENUM('DEPLOY_COMPLETION') NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SENT') NOT NULL DEFAULT 'PENDING',
    `payload` JSON NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastError` TEXT NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `telegram_notification_dedupeKey_key`(`dedupeKey`),
    INDEX `telegram_notification_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 배포 시점 이전의 완료 이력은 이미 전달된 것으로 표시해 첫 reconcile 때
-- 과거 성공·실패 알림이 한꺼번에 전송되지 않게 한다.
INSERT INTO `telegram_notification` (
    `id`,
    `dedupeKey`,
    `kind`,
    `status`,
    `payload`,
    `attempts`,
    `nextAttemptAt`,
    `sentAt`,
    `createdAt`,
    `updatedAt`
)
SELECT
    CONCAT('legacy_', rr.`id`),
    CONCAT(
        'deploy:',
        rr.`id`,
        ':',
        CASE
            WHEN rr.`workflowRunId` IS NOT NULL THEN CONCAT(
                'github:',
                CAST(rr.`workflowRunId` AS CHAR),
                ':',
                COALESCE(wr.`runAttempt`, 1)
            )
            WHEN rr.`externalRunId` IS NOT NULL THEN CONCAT('xcode:', rr.`externalRunId`)
            ELSE 'legacy'
        END
    ),
    'DEPLOY_COMPLETION',
    'SENT',
    JSON_OBJECT('releaseRecordId', rr.`id`, 'status', rr.`status`),
    0,
    CURRENT_TIMESTAMP(3),
    CURRENT_TIMESTAMP(3),
    CURRENT_TIMESTAMP(3),
    CURRENT_TIMESTAMP(3)
FROM `release_record` rr
LEFT JOIN `workflow_run_mirror` wr
    ON wr.`runId` = rr.`workflowRunId`
WHERE rr.`status` IN ('SUCCEEDED', 'FAILED');
