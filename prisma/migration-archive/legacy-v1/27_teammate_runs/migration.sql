-- AI 팀원 실행 원장. 멘션 응답과 순찰 실행을 기록하고,
-- dedupeKey unique 로 Gateway resume 중복 응답과 순찰 중복 트리거를 막는다.
CREATE TABLE `teammate_run` (
    `id` VARCHAR(191) NOT NULL,
    `teammate` VARCHAR(191) NOT NULL,
    `trigger` VARCHAR(191) NOT NULL,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `scope` TEXT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `findingCount` INTEGER NOT NULL DEFAULT 0,
    `findings` JSON NULL,
    `issueUrls` JSON NULL,
    `outcome` TEXT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `teammate_run_dedupeKey_key`(`dedupeKey`),
    INDEX `teammate_run_teammate_createdAt_idx`(`teammate`, `createdAt`),
    INDEX `teammate_run_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
