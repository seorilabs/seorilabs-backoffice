CREATE TABLE `realtime_activity_sample` (
    `appId` VARCHAR(191) NOT NULL,
    `bucketAt` DATETIME(3) NOT NULL,
    `activeUsers` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `realtime_activity_sample_bucketAt_idx`(`bucketAt`),
    PRIMARY KEY (`appId`,`bucketAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `realtime_activity_spike_state` (
    `appId` VARCHAR(191) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT false,
    `highStreak` INTEGER NOT NULL DEFAULT 0,
    `lowStreak` INTEGER NOT NULL DEFAULT 0,
    `highStartedAt` DATETIME(3) NULL,
    `lastAlertAt` DATETIME(3) NULL,
    `lastSampleAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`appId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `realtime_activity_sample` ADD CONSTRAINT `realtime_activity_sample_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `realtime_activity_spike_state` ADD CONSTRAINT `realtime_activity_spike_state_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
