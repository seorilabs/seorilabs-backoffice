-- AlterTable
ALTER TABLE `automation_definition`
    ADD COLUMN `agentKind` VARCHAR(191) NULL,
    ADD COLUMN `model` VARCHAR(191) NULL,
    ADD COLUMN `configuration` JSON NULL,
    ADD COLUMN `pausedAt` DATETIME(3) NULL,
    ADD COLUMN `cancelledAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `automation_occurrence`
    ADD COLUMN `triggerKind` VARCHAR(191) NULL,
    ADD COLUMN `triggerKey` VARCHAR(191) NULL,
    ADD COLUMN `result` JSON NULL;

-- AlterTable
ALTER TABLE `agent_run`
    ADD COLUMN `workKey` VARCHAR(191) NULL,
    ADD COLUMN `spentMicros` BIGINT NULL,
    ADD COLUMN `readbackRequestedAt` DATETIME(3) NULL,
    ADD COLUMN `cancelledAt` DATETIME(3) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `automation_occurrence_triggerKey_key` ON `automation_occurrence`(`triggerKey`);

-- CreateIndex
CREATE UNIQUE INDEX `agent_run_workKey_key` ON `agent_run`(`workKey`);

-- CreateTable
CREATE TABLE `agent_repo_guard` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `activeScopeKey` VARCHAR(191) NULL,
    `acquiredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `releasedAt` DATETIME(3) NULL,

    UNIQUE INDEX `agent_repo_guard_runId_key`(`runId`),
    UNIQUE INDEX `agent_repo_guard_activeScopeKey_key`(`activeScopeKey`),
    INDEX `agent_repo_guard_repoFullName_releasedAt_idx`(`repoFullName`, `releasedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_ingress_event` (
    `id` VARCHAR(191) NOT NULL,
    `sourceKey` VARCHAR(191) NOT NULL,
    `event` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NULL,
    `issueNodeId` VARCHAR(191) NULL,
    `payload` JSON NULL,
    `payloadHash` CHAR(64) NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `eligibleAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `automation_ingress_event_sourceKey_key`(`sourceKey`),
    INDEX `automation_ingress_event_status_eligibleAt_idx`(`status`, `eligibleAt`),
    INDEX `automation_ingress_event_repoFullName_issueNumber_idx`(`repoFullName`, `issueNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_mutation_request` (
    `requestId` VARCHAR(191) NOT NULL,
    `actor` VARCHAR(191) NOT NULL,
    `operation` VARCHAR(191) NOT NULL,
    `targetKey` VARCHAR(191) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `request` JSON NOT NULL,
    `response` JSON NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `automation_mutation_request_status_updatedAt_idx`(`status`, `updatedAt`),
    PRIMARY KEY (`requestId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fleet_project_projection` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `projectNodeId` VARCHAR(191) NOT NULL,
    `issueNodeId` VARCHAR(191) NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NOT NULL,
    `desired` JSON NOT NULL,
    `desiredHash` CHAR(64) NOT NULL,
    `observed` JSON NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `appliedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `fleet_project_projection_projectNodeId_issueNodeId_key`(`projectNodeId`, `issueNodeId`),
    INDEX `fleet_project_projection_appId_status_idx`(`appId`, `status`),
    INDEX `fleet_project_projection_status_updatedAt_idx`(`status`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `agent_repo_guard` ADD CONSTRAINT `agent_repo_guard_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `agent_run`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fleet_project_projection` ADD CONSTRAINT `fleet_project_projection_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
