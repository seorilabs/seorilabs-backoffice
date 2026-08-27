-- CreateTable
CREATE TABLE `ai_draft` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `stage` ENUM('PLANNING', 'DEVELOPMENT', 'QA', 'MARKET_SUBMISSION', 'RELEASE', 'LIVEOPS') NOT NULL,
    `kind` ENUM('PLANNING_SPEC', 'TASK_BREAKDOWN', 'RELEASE_NOTES') NOT NULL,
    `title` TEXT NULL,
    `issueNumber` INTEGER NULL,
    `inputJson` JSON NOT NULL,
    `outputText` TEXT NOT NULL,
    `model` VARCHAR(191) NOT NULL,
    `status` ENUM('DRAFT', 'COMMITTED', 'DISCARDED') NOT NULL DEFAULT 'DRAFT',
    `committedIssueNumber` INTEGER NULL,
    `committedUrl` VARCHAR(191) NULL,
    `committedAt` DATETIME(3) NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ai_draft_appId_stage_status_idx`(`appId`, `stage`, `status`),
    INDEX `ai_draft_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ai_draft` ADD CONSTRAINT `ai_draft_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

