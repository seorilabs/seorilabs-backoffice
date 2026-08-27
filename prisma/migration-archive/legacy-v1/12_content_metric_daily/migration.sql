-- CreateTable
CREATE TABLE `app_content_metric_daily` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `totalEvents` INTEGER NOT NULL DEFAULT 0,
    `raw` JSON NOT NULL,
    `collectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `app_content_metric_daily_date_idx`(`date`),
    UNIQUE INDEX `app_content_metric_daily_appId_date_key`(`appId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `app_content_metric_daily` ADD CONSTRAINT `app_content_metric_daily_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
