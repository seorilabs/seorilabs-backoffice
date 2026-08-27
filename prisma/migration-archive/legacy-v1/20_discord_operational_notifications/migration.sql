-- Telegram 전용 outbox를 공급자 중립 이벤트/배달 구조로 이관하고
-- Platform 확정 이벤트의 멱등 수신 원장을 추가한다.
CREATE TABLE `notification_event` (
    `id` VARCHAR(191) NOT NULL,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `kind` ENUM('DEPLOY_COMPLETION', 'DAILY_METRICS', 'OPERATIONS_SUMMARY', 'OPERATIONAL_EVENT', 'OPS_ALERT') NOT NULL,
    `payload` JSON NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `notification_event_dedupeKey_key`(`dedupeKey`),
    INDEX `notification_event_kind_occurredAt_idx`(`kind`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `notification_delivery` (
    `id` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `provider` ENUM('TELEGRAM', 'DISCORD') NOT NULL,
    `destinationKey` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SENT', 'DEAD_LETTER') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastError` TEXT NULL,
    `providerMessageId` VARCHAR(191) NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `notification_delivery_eventId_provider_destinationKey_key`(`eventId`, `provider`, `destinationKey`),
    INDEX `notification_delivery_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `operational_event` (
    `eventId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `outcome` VARCHAR(191) NOT NULL,
    `attributes` JSON NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `operational_event_occurredAt_idx`(`occurredAt`),
    INDEX `operational_event_appId_eventType_occurredAt_idx`(`appId`, `eventType`, `occurredAt`),
    PRIMARY KEY (`eventId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 기존 성공/실패/대기 상태를 그대로 옮긴다. event/delivery ID는 기존 ID에서
-- 결정적으로 만들어 마이그레이션 재검토와 운영 readback이 쉽도록 한다.
INSERT INTO `notification_event` (`id`, `dedupeKey`, `kind`, `payload`, `occurredAt`, `createdAt`)
SELECT CONCAT('event_', `id`), `dedupeKey`, `kind`, `payload`, `createdAt`, `createdAt`
FROM `telegram_notification`;

INSERT INTO `notification_delivery` (
    `id`, `eventId`, `provider`, `destinationKey`, `status`, `attempts`,
    `nextAttemptAt`, `lastError`, `sentAt`, `createdAt`, `updatedAt`
)
SELECT
    CONCAT('delivery_', `id`), CONCAT('event_', `id`), 'TELEGRAM', 'default',
    `status`, `attempts`, `nextAttemptAt`, `lastError`, `sentAt`, `createdAt`, `updatedAt`
FROM `telegram_notification`;

ALTER TABLE `notification_delivery`
    ADD CONSTRAINT `notification_delivery_eventId_fkey`
    FOREIGN KEY (`eventId`) REFERENCES `notification_event`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

DROP TABLE `telegram_notification`;
