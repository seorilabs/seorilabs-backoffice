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
        'STORE_REVIEW'
    ) NOT NULL;

CREATE TABLE `store_review_sync` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `store` ENUM('GOOGLE_PLAY', 'APP_STORE') NOT NULL,
    `initializedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSuccessfulAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `store_review_sync_store_lastSuccessfulAt_idx`(`store`, `lastSuccessfulAt`),
    UNIQUE INDEX `store_review_sync_appId_store_key`(`appId`, `store`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `store_review_observation` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `store` ENUM('GOOGLE_PLAY', 'APP_STORE') NOT NULL,
    `externalReviewId` VARCHAR(191) NOT NULL,
    `rating` INTEGER NOT NULL,
    `contentHash` VARCHAR(191) NOT NULL,
    `notifiedHash` VARCHAR(191) NULL,
    `sourceCreatedAt` DATETIME(3) NULL,
    `sourceModifiedAt` DATETIME(3) NULL,
    `firstObservedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastObservedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `store_review_observation_appId_store_sourceModifiedAt_idx`(`appId`, `store`, `sourceModifiedAt`),
    UNIQUE INDEX `store_review_observation_appId_store_externalReviewId_key`(`appId`, `store`, `externalReviewId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `store_review_sync`
    ADD CONSTRAINT `store_review_sync_appId_fkey`
    FOREIGN KEY (`appId`) REFERENCES `app`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `store_review_observation`
    ADD CONSTRAINT `store_review_observation_appId_fkey`
    FOREIGN KEY (`appId`) REFERENCES `app`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
