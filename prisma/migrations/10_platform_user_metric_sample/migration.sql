-- CreateTable
CREATE TABLE `platform_user_metric_sample` (
    `id` VARCHAR(191) NOT NULL,
    `capturedAt` DATETIME(3) NOT NULL,
    `totalUsers` INTEGER NOT NULL DEFAULT 0,
    `hourlyActiveUsers` INTEGER NOT NULL DEFAULT 0,
    `dailyActiveUsers` INTEGER NOT NULL DEFAULT 0,
    `weeklyActiveUsers` INTEGER NOT NULL DEFAULT 0,
    `activitySource` VARCHAR(191) NOT NULL DEFAULT 'session_last_seen',
    `collectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `platform_user_metric_sample_capturedAt_key`(`capturedAt`),
    INDEX `platform_user_metric_sample_capturedAt_idx`(`capturedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
