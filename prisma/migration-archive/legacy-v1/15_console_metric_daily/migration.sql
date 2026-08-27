-- AlterTable
ALTER TABLE `app` ADD COLUMN `aitWorkspaceId` INTEGER NULL,
    ADD COLUMN `aitMiniAppId` INTEGER NULL;

-- CreateTable
CREATE TABLE `app_console_metric_daily` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `dau` INTEGER NOT NULL DEFAULT 0,
    `newUsers` INTEGER NOT NULL DEFAULT 0,
    `avgSessionSec` DOUBLE NULL,
    `iaaImpressions` INTEGER NOT NULL DEFAULT 0,
    `iaaEarningKrw` DOUBLE NOT NULL DEFAULT 0,
    `iapTrxAmountKrw` DOUBLE NOT NULL DEFAULT 0,
    `iapSettlementKrw` DOUBLE NOT NULL DEFAULT 0,
    `payingUsers` INTEGER NOT NULL DEFAULT 0,
    `raw` JSON NULL,
    `collectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `app_console_metric_daily_date_idx`(`date`),
    UNIQUE INDEX `app_console_metric_daily_appId_date_key`(`appId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `app_aitMiniAppId_key` ON `app`(`aitMiniAppId`);

-- AddForeignKey
ALTER TABLE `app_console_metric_daily` ADD CONSTRAINT `app_console_metric_daily_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
