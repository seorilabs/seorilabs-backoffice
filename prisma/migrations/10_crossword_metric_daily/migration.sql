-- CreateTable: 가로세로 낱말 퍼즐 게임 세부 지표 스냅샷(날짜×마켓).
-- 공통 지표(app_metric_daily)와 분리된 게임 전용 표 — 다른 게임과 충돌하지 않게 별도 테이블.
CREATE TABLE `crossword_metric_daily` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `market` VARCHAR(191) NOT NULL,
    `starts` INTEGER NOT NULL DEFAULT 0,
    `firstInputs` INTEGER NOT NULL DEFAULT 0,
    `progressReaches` INTEGER NOT NULL DEFAULT 0,
    `completes` INTEGER NOT NULL DEFAULT 0,
    `abandons` INTEGER NOT NULL DEFAULT 0,
    `completionRatePct` DOUBLE NULL,
    `avgSolveTimeSec` DOUBLE NULL,
    `noHintCompletes` INTEGER NOT NULL DEFAULT 0,
    `firstTryCompletes` INTEGER NOT NULL DEFAULT 0,
    `hintUses` INTEGER NOT NULL DEFAULT 0,
    `revealUses` INTEGER NOT NULL DEFAULT 0,
    `stuckHintUses` INTEGER NOT NULL DEFAULT 0,
    `assistAdRequests` INTEGER NOT NULL DEFAULT 0,
    `assistAdRewards` INTEGER NOT NULL DEFAULT 0,
    `players` INTEGER NOT NULL DEFAULT 0,
    `completePlayers` INTEGER NOT NULL DEFAULT 0,
    `breakdowns` JSON NULL,
    `collectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `crossword_metric_daily_appId_date_idx`(`appId`, `date`),
    INDEX `crossword_metric_daily_date_idx`(`date`),
    UNIQUE INDEX `crossword_metric_daily_appId_date_market_key`(`appId`, `date`, `market`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `crossword_metric_daily` ADD CONSTRAINT `crossword_metric_daily_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
