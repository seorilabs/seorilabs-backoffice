-- AlterTable
ALTER TABLE `app` ADD COLUMN `ga4Dataset` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `app_metric_daily` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `dau` INTEGER NOT NULL DEFAULT 0,
    `newUsers` INTEGER NOT NULL DEFAULT 0,
    `returnRatePct` DOUBLE NULL,
    `d1Pct` DOUBLE NULL,
    `d3Pct` DOUBLE NULL,
    `d7Pct` DOUBLE NULL,
    `engagedUsers` INTEGER NOT NULL DEFAULT 0,
    `avgEngageSec` DOUBLE NULL,
    `adEventUsers` INTEGER NOT NULL DEFAULT 0,
    `adImpressions` INTEGER NOT NULL DEFAULT 0,
    `raw` JSON NULL,
    `collectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `app_metric_daily_date_idx`(`date`),
    UNIQUE INDEX `app_metric_daily_appId_date_key`(`appId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `app_metric_daily` ADD CONSTRAINT `app_metric_daily_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

