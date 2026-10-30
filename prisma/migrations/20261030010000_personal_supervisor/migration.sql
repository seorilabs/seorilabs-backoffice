-- AlterTable
ALTER TABLE `operator_command_run` ADD COLUMN `checkpoint` JSON NULL,
    ADD COLUMN `executionLocation` VARCHAR(16) NULL DEFAULT 'SERVER',
    ADD COLUMN `executionOwner` VARCHAR(128) NULL,
    ADD COLUMN `generation` INTEGER NULL DEFAULT 0,
    ADD COLUMN `leaseUntil` DATETIME(3) NULL,
    ADD COLUMN `localState` VARCHAR(32) NULL;

-- CreateTable
CREATE TABLE `work_target` (
    `id` VARCHAR(128) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `repository` VARCHAR(191) NULL,
    `appId` VARCHAR(191) NULL,
    `policySha` VARCHAR(40) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `work_observation` (
    `id` VARCHAR(128) NOT NULL,
    `targetId` VARCHAR(128) NOT NULL,
    `problemKey` VARCHAR(128) NOT NULL,
    `source` VARCHAR(64) NOT NULL,
    `summary` TEXT NOT NULL,
    `references` JSON NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `waitUntil` DATETIME(3) NULL,
    `samples` INTEGER NOT NULL DEFAULT 1,
    `minSamples` INTEGER NOT NULL DEFAULT 1,
    `resolved` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `work_observation_targetId_problemKey_observedAt_idx`(`targetId`, `problemKey`, `observedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `work_proposal` (
    `id` VARCHAR(191) NOT NULL,
    `targetId` VARCHAR(128) NOT NULL,
    `problemKey` VARCHAR(128) NOT NULL,
    `version` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `digest` VARCHAR(64) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'READY',
    `snoozedUntil` DATETIME(3) NULL,
    `decidedBy` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `runId` VARCHAR(191) NULL,
    `publicationDay` VARCHAR(10) NULL,
    `deliveryState` VARCHAR(32) NULL,
    `messageId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `work_proposal_runId_key`(`runId`),
    INDEX `work_proposal_status_createdAt_idx`(`status`, `createdAt`),
    UNIQUE INDEX `work_proposal_targetId_problemKey_version_key`(`targetId`, `problemKey`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `work_coordinator` (
    `id` INTEGER NOT NULL,
    `mode` VARCHAR(16) NOT NULL DEFAULT 'OBSERVE',
    `activeRunId` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `work_analysis` (
    `day` VARCHAR(10) NOT NULL,
    `owner` VARCHAR(128) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deadline` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,

    PRIMARY KEY (`day`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `work_event` (
    `id` VARCHAR(128) NOT NULL,
    `proposalId` VARCHAR(191) NULL,
    `runId` VARCHAR(191) NULL,
    `kind` VARCHAR(32) NOT NULL,
    `actor` VARCHAR(191) NOT NULL,
    `details` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `work_event_proposalId_createdAt_idx`(`proposalId`, `createdAt`),
    INDEX `work_event_runId_createdAt_idx`(`runId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `operator_command_run_executionLocation_status_createdAt_idx` ON `operator_command_run`(`executionLocation`, `status`, `createdAt`);

-- AddForeignKey
ALTER TABLE `work_observation` ADD CONSTRAINT `work_observation_targetId_fkey` FOREIGN KEY (`targetId`) REFERENCES `work_target`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `work_proposal` ADD CONSTRAINT `work_proposal_targetId_fkey` FOREIGN KEY (`targetId`) REFERENCES `work_target`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `work_proposal` ADD CONSTRAINT `work_proposal_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `operator_command_run`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

