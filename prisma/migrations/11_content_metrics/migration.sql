-- 콘텐츠 세부 지표(foam-party 타입드) — 콘텐츠 이벤트 일별 집계 4종.
-- market = platform(android=Google Play, ios=App Store, web=AIT). 시장별 1행,
-- 통합 뷰는 합산 파생. 기준일 D-1, WINDOW 일 재집계 멱등 upsert.

-- CreateTable: 레벨 퍼널
CREATE TABLE `app_level_metric_daily` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `platform` VARCHAR(191) NOT NULL,
    `level` INTEGER NOT NULL,
    `starts` INTEGER NOT NULL DEFAULT 0,
    `completes` INTEGER NOT NULL DEFAULT 0,
    `players` INTEGER NOT NULL DEFAULT 0,
    `avgClearSec` DOUBLE NULL,
    `avgStars` DOUBLE NULL,
    `coinsEarned` INTEGER NOT NULL DEFAULT 0,
    `collectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `app_level_metric_daily_appId_date_idx`(`appId`, `date`),
    UNIQUE INDEX `app_level_metric_daily_appId_date_platform_level_key`(`appId`, `date`, `platform`, `level`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: 수익화 분포
CREATE TABLE `app_monetization_daily` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `platform` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `itemKey` VARCHAR(191) NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 0,
    `users` INTEGER NOT NULL DEFAULT 0,
    `coinsSpent` INTEGER NOT NULL DEFAULT 0,
    `adCount` INTEGER NOT NULL DEFAULT 0,
    `collectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `app_monetization_daily_appId_date_idx`(`appId`, `date`),
    UNIQUE INDEX `app_monetization_daily_appId_date_platform_kind_itemKey_key`(`appId`, `date`, `platform`, `kind`, `itemKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: 미션·리텐션 훅
CREATE TABLE `app_mission_metric_daily` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `platform` VARCHAR(191) NOT NULL,
    `missionType` VARCHAR(191) NOT NULL,
    `claims` INTEGER NOT NULL DEFAULT 0,
    `users` INTEGER NOT NULL DEFAULT 0,
    `rewardCoins` INTEGER NOT NULL DEFAULT 0,
    `collectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `app_mission_metric_daily_appId_date_idx`(`appId`, `date`),
    UNIQUE INDEX `app_mission_metric_daily_appId_date_platform_missionType_key`(`appId`, `date`, `platform`, `missionType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: 경제/재화 흐름
CREATE TABLE `app_economy_metric_daily` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `platform` VARCHAR(191) NOT NULL,
    `coinsFromLevels` INTEGER NOT NULL DEFAULT 0,
    `coinsFromMissions` INTEGER NOT NULL DEFAULT 0,
    `coinsToUpgrades` INTEGER NOT NULL DEFAULT 0,
    `coinsToSkins` INTEGER NOT NULL DEFAULT 0,
    `coinsToFoamBombs` INTEGER NOT NULL DEFAULT 0,
    `foamBombAd` INTEGER NOT NULL DEFAULT 0,
    `foamBombCoin` INTEGER NOT NULL DEFAULT 0,
    `collectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `app_economy_metric_daily_appId_date_idx`(`appId`, `date`),
    UNIQUE INDEX `app_economy_metric_daily_appId_date_platform_key`(`appId`, `date`, `platform`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `app_level_metric_daily` ADD CONSTRAINT `app_level_metric_daily_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `app_monetization_daily` ADD CONSTRAINT `app_monetization_daily_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `app_mission_metric_daily` ADD CONSTRAINT `app_mission_metric_daily_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `app_economy_metric_daily` ADD CONSTRAINT `app_economy_metric_daily_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
