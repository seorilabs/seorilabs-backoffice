-- AlterTable
ALTER TABLE `notification_delivery` ADD COLUMN `providerReceipt` JSON NULL;

ALTER TABLE `notification_delivery` MODIFY `provider` ENUM('DISCORD', 'SLACK') NOT NULL;

-- AlterTable
ALTER TABLE `operator_command_run` ADD COLUMN `sourceProvider` ENUM('DISCORD', 'SLACK') NULL DEFAULT 'DISCORD';

-- AlterTable
ALTER TABLE `operational_incident` ADD COLUMN `messageProvider` ENUM('DISCORD', 'SLACK') NULL DEFAULT 'DISCORD';

-- CreateTable
CREATE TABLE `slack_account_link` (
    `githubId` BIGINT NOT NULL,
    `slackUserId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `slack_account_link_slackUserId_key`(`slackUserId`),
    PRIMARY KEY (`githubId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `slack_link_code` (
    `codeHash` VARCHAR(191) NOT NULL,
    `githubId` BIGINT NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `slack_link_code_githubId_expiresAt_idx`(`githubId`, `expiresAt`),
    PRIMARY KEY (`codeHash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `slack_turn` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `channelId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `content` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `slack_turn_workspaceId_channelId_userId_createdAt_idx`(`workspaceId`, `channelId`, `userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `slack_request_receipt` (
    `id` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `slack_request_receipt_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
