-- CreateTable
CREATE TABLE `store_review_submission_observation` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `store` ENUM('GOOGLE_PLAY', 'APP_STORE') NOT NULL,
    `externalEventId` VARCHAR(191) NOT NULL,
    `externalSubmissionId` VARCHAR(191) NULL,
    `externalVersionId` VARCHAR(191) NULL,
    `state` VARCHAR(191) NOT NULL,
    `stateLabel` VARCHAR(191) NOT NULL,
    `previousState` VARCHAR(191) NULL,
    `rawPayload` JSON NOT NULL,
    `contentHash` VARCHAR(191) NOT NULL,
    `notifiedHash` VARCHAR(191) NULL,
    `trackName` VARCHAR(191) NULL,
    `sourceEventAt` DATETIME(3) NOT NULL,
    `firstObservedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastObservedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_sro_app_store_event`(`appId`, `store`, `sourceEventAt`),
    INDEX `ix_sro_store_ver`(`store`, `externalVersionId`),
    INDEX `store_review_submission_observation_store_expiresAt_idx`(`store`, `expiresAt`),
    UNIQUE INDEX `store_review_submission_observation_store_externalEventId_key`(`store`, `externalEventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `store_review_submission_sync` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `store` ENUM('GOOGLE_PLAY', 'APP_STORE') NOT NULL,
    `webhookId` VARCHAR(191) NULL,
    `lastSuccessAt` DATETIME(3) NULL,
    `lastFailureAt` DATETIME(3) NULL,
    `lastFailureReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `store_review_submission_sync_store_lastSuccessAt_idx`(`store`, `lastSuccessAt`),
    UNIQUE INDEX `store_review_submission_sync_appId_store_key`(`appId`, `store`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `store_review_submission_observation` ADD CONSTRAINT `store_review_submission_observation_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `store_review_submission_sync` ADD CONSTRAINT `store_review_submission_sync_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
