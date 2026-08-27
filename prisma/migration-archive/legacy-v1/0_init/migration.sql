-- CreateTable
CREATE TABLE `app` (
    `id` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `repoId` BIGINT NULL,
    `type` ENUM('APP', 'GAME') NOT NULL,
    `engine` ENUM('RN', 'GODOT') NOT NULL,
    `status` ENUM('ACTIVE', 'PAUSED', 'DEPRECATED') NOT NULL DEFAULT 'ACTIVE',
    `currentStage` ENUM('PLANNING', 'DEVELOPMENT', 'QA', 'MARKET_SUBMISSION', 'RELEASE', 'LIVEOPS') NOT NULL DEFAULT 'PLANNING',
    `isPublicRepo` BOOLEAN NOT NULL DEFAULT false,
    `firebaseProject` VARCHAR(191) NULL,
    `playPackage` VARCHAR(191) NULL,
    `iosBundle` VARCHAR(191) NULL,
    `appleTeamId` VARCHAR(191) NULL,
    `iosSku` VARCHAR(191) NULL,
    `aitAppName` VARCHAR(191) NULL,
    `marketTargets` JSON NOT NULL,
    `configHash` VARCHAR(191) NULL,
    `configSyncedAt` DATETIME(3) NULL,
    `projectV2Id` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `app_slug_key`(`slug`),
    UNIQUE INDEX `app_repoFullName_key`(`repoFullName`),
    UNIQUE INDEX `app_repoId_key`(`repoId`),
    UNIQUE INDEX `app_playPackage_key`(`playPackage`),
    INDEX `app_status_currentStage_idx`(`status`, `currentStage`),
    INDEX `app_type_engine_idx`(`type`, `engine`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stage_transition` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `fromStage` ENUM('PLANNING', 'DEVELOPMENT', 'QA', 'MARKET_SUBMISSION', 'RELEASE', 'LIVEOPS') NULL,
    `toStage` ENUM('PLANNING', 'DEVELOPMENT', 'QA', 'MARKET_SUBMISSION', 'RELEASE', 'LIVEOPS') NOT NULL,
    `source` ENUM('BACKOFFICE', 'GITHUB', 'SYSTEM') NOT NULL,
    `actorLogin` VARCHAR(191) NULL,
    `reason` TEXT NULL,
    `signalRef` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stage_transition_appId_createdAt_idx`(`appId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `issue_mirror` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `number` INTEGER NOT NULL,
    `nodeId` VARCHAR(191) NOT NULL,
    `title` TEXT NOT NULL,
    `state` ENUM('OPEN', 'CLOSED') NOT NULL,
    `stateReason` VARCHAR(191) NULL,
    `authorLogin` VARCHAR(191) NULL,
    `assignees` JSON NOT NULL,
    `labels` JSON NOT NULL,
    `milestone` VARCHAR(191) NULL,
    `priority` ENUM('P1', 'P2', 'P3', 'P4') NULL,
    `isAutopilot` BOOLEAN NOT NULL DEFAULT false,
    `hasEvidence` BOOLEAN NOT NULL DEFAULT false,
    `isBlocked` BOOLEAN NOT NULL DEFAULT false,
    `source` ENUM('BACKOFFICE', 'CLAUDE_CODE', 'ROUTINE', 'UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
    `clientReqId` VARCHAR(191) NULL,
    `linkedPrUrl` VARCHAR(191) NULL,
    `ghCreatedAt` DATETIME(3) NOT NULL,
    `ghUpdatedAt` DATETIME(3) NOT NULL,
    `mirroredAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `issue_mirror_nodeId_key`(`nodeId`),
    UNIQUE INDEX `issue_mirror_clientReqId_key`(`clientReqId`),
    INDEX `issue_mirror_appId_state_idx`(`appId`, `state`),
    INDEX `issue_mirror_state_priority_idx`(`state`, `priority`),
    UNIQUE INDEX `issue_mirror_repoFullName_number_key`(`repoFullName`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pull_request_mirror` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `number` INTEGER NOT NULL,
    `nodeId` VARCHAR(191) NOT NULL,
    `title` TEXT NOT NULL,
    `state` ENUM('OPEN', 'CLOSED', 'MERGED') NOT NULL,
    `isDraft` BOOLEAN NOT NULL DEFAULT false,
    `authorLogin` VARCHAR(191) NULL,
    `headRef` VARCHAR(191) NULL,
    `baseRef` VARCHAR(191) NULL,
    `labels` JSON NOT NULL,
    `linkedIssue` INTEGER NULL,
    `isAutopilotPr` BOOLEAN NOT NULL DEFAULT false,
    `mergedAt` DATETIME(3) NULL,
    `ghCreatedAt` DATETIME(3) NOT NULL,
    `ghUpdatedAt` DATETIME(3) NOT NULL,
    `mirroredAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `pull_request_mirror_nodeId_key`(`nodeId`),
    INDEX `pull_request_mirror_appId_state_idx`(`appId`, `state`),
    UNIQUE INDEX `pull_request_mirror_repoFullName_number_key`(`repoFullName`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workflow_run_mirror` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `runId` BIGINT NOT NULL,
    `name` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL,
    `conclusion` VARCHAR(191) NULL,
    `event` VARCHAR(191) NULL,
    `headSha` VARCHAR(191) NULL,
    `headBranch` VARCHAR(191) NULL,
    `runAttempt` INTEGER NOT NULL DEFAULT 1,
    `runStartedAt` DATETIME(3) NULL,
    `ghUpdatedAt` DATETIME(3) NOT NULL,
    `mirroredAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `workflow_run_mirror_runId_key`(`runId`),
    INDEX `workflow_run_mirror_appId_name_idx`(`appId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `release_record` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `version` VARCHAR(191) NOT NULL,
    `market` ENUM('PLAY', 'APPSTORE', 'AIT', 'WEB') NOT NULL,
    `track` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK') NOT NULL DEFAULT 'PENDING',
    `workflowRunId` BIGINT NULL,
    `workflowName` VARCHAR(191) NULL,
    `commitSha` VARCHAR(191) NULL,
    `triggeredBy` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NULL,
    `deployedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `release_record_appId_market_deployedAt_idx`(`appId`, `market`, `deployedAt`),
    UNIQUE INDEX `release_record_market_workflowRunId_key`(`market`, `workflowRunId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_user` (
    `id` VARCHAR(191) NOT NULL,
    `githubId` BIGINT NOT NULL,
    `login` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `avatarUrl` VARCHAR(191) NULL,
    `role` ENUM('ADMIN', 'MAINTAINER', 'VIEWER') NOT NULL DEFAULT 'VIEWER',
    `allowlisted` BOOLEAN NOT NULL DEFAULT false,
    `lastLoginAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `app_user_githubId_key`(`githubId`),
    UNIQUE INDEX `app_user_login_key`(`login`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_owner` (
    `appId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `role` ENUM('OWNER', 'CONTRIBUTOR') NOT NULL DEFAULT 'OWNER',

    PRIMARY KEY (`appId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_delivery` (
    `deliveryId` VARCHAR(191) NOT NULL,
    `event` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `webhook_delivery_receivedAt_idx`(`receivedAt`),
    PRIMARY KEY (`deliveryId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sync_cursor` (
    `repoFullName` VARCHAR(191) NOT NULL,
    `lastIssueSync` DATETIME(3) NULL,
    `lastPrSync` DATETIME(3) NULL,
    `lastRunSync` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`repoFullName`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_log` (
    `id` VARCHAR(191) NOT NULL,
    `actorLogin` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NULL,
    `payload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_log_entityType_entityId_idx`(`entityType`, `entityId`),
    INDEX `audit_log_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `stage_transition` ADD CONSTRAINT `stage_transition_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `issue_mirror` ADD CONSTRAINT `issue_mirror_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pull_request_mirror` ADD CONSTRAINT `pull_request_mirror_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workflow_run_mirror` ADD CONSTRAINT `workflow_run_mirror_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `release_record` ADD CONSTRAINT `release_record_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_owner` ADD CONSTRAINT `app_owner_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_owner` ADD CONSTRAINT `app_owner_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `app_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

