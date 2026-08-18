ALTER TABLE `notification_event`
    MODIFY `kind` ENUM(
        'DEPLOY_COMPLETION',
        'DAILY_METRICS',
        'OPERATIONS_SUMMARY',
        'OPERATIONAL_EVENT',
        'OPS_ALERT',
        'EXTERNAL_FEED',
        'MILESTONE',
        'INCIDENT'
    ) NOT NULL;

ALTER TABLE `notification_delivery`
    ADD COLUMN `deletedAt` DATETIME(3) NULL;

CREATE TABLE `discord_turn` (
    `id` VARCHAR(191) NOT NULL,
    `guildId` VARCHAR(191) NOT NULL,
    `channelId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `content` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `discord_turn_guildId_channelId_userId_createdAt_idx`(`guildId`, `channelId`, `userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `operator_command_run` (
    `id` VARCHAR(191) NOT NULL,
    `sourceInteractionId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `operation` VARCHAR(191) NOT NULL,
    `params` JSON NULL,
    `actorDiscordUserId` VARCHAR(191) NOT NULL,
    `actorLabel` VARCHAR(191) NOT NULL,
    `channelId` VARCHAR(191) NOT NULL,
    `messageId` VARCHAR(191) NULL,
    `status` ENUM('AWAITING_CONFIRMATION', 'PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'AWAITING_CONFIRMATION',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `summary` TEXT NULL,
    `error` TEXT NULL,
    `confirmedAt` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `redactedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `operator_command_run_sourceInteractionId_key`(`sourceInteractionId`),
    INDEX `operator_command_run_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `operator_command_run_redactedAt_expiresAt_idx`(`redactedAt`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `operational_incident` (
    `id` VARCHAR(191) NOT NULL,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `source` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `severity` VARCHAR(191) NOT NULL,
    `status` ENUM('OPEN', 'ACKNOWLEDGED', 'RECOVERED') NOT NULL DEFAULT 'OPEN',
    `summary` TEXT NOT NULL,
    `evidence` JSON NULL,
    `destinationKey` VARCHAR(191) NOT NULL DEFAULT 'ops-alerts',
    `providerMessageId` VARCHAR(191) NULL,
    `acknowledgedBy` VARCHAR(191) NULL,
    `acknowledgedAt` DATETIME(3) NULL,
    `assignedDiscordUserId` VARCHAR(191) NULL,
    `firstDetectedAt` DATETIME(3) NOT NULL,
    `lastDetectedAt` DATETIME(3) NOT NULL,
    `recoveredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `operational_incident_dedupeKey_key`(`dedupeKey`),
    INDEX `operational_incident_status_severity_lastDetectedAt_idx`(`status`, `severity`, `lastDetectedAt`),
    INDEX `operational_incident_appId_status_idx`(`appId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `operational_milestone` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `firstEventId` VARCHAR(191) NOT NULL,
    `firstObservedAt` DATETIME(3) NOT NULL,
    `notifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `operational_milestone_appId_eventType_key`(`appId`, `eventType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `operator_command_run`
    ADD CONSTRAINT `operator_command_run_appId_fkey`
    FOREIGN KEY (`appId`) REFERENCES `app`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `operational_incident`
    ADD CONSTRAINT `operational_incident_appId_fkey`
    FOREIGN KEY (`appId`) REFERENCES `app`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `operational_milestone`
    ADD CONSTRAINT `operational_milestone_appId_fkey`
    FOREIGN KEY (`appId`) REFERENCES `app`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 이미 수집된 이벤트 조합은 재알림 없이 선반영한다.
INSERT INTO `operational_milestone` (
    `id`, `appId`, `eventType`, `firstEventId`, `firstObservedAt`, `notifiedAt`, `createdAt`
)
SELECT
    CONCAT('milestone_', SHA2(CONCAT(`app`.`id`, ':', `operational_event`.`eventType`), 256)),
    `app`.`id`,
    `operational_event`.`eventType`,
    SUBSTRING_INDEX(GROUP_CONCAT(`operational_event`.`eventId` ORDER BY `operational_event`.`occurredAt` ASC), ',', 1),
    MIN(`operational_event`.`occurredAt`),
    CURRENT_TIMESTAMP(3),
    CURRENT_TIMESTAMP(3)
FROM `operational_event`
INNER JOIN `app` ON `app`.`slug` = `operational_event`.`appId`
WHERE `operational_event`.`eventType` IN ('identity.created', 'iap.granted', 'ad.reward.delivered')
GROUP BY `app`.`id`, `operational_event`.`eventType`;
