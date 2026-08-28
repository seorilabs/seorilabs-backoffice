-- P4 Platform Fleet durable release and per-repository reconciliation ledger.

ALTER TABLE `agent_run`
    ADD COLUMN `taskInput` JSON NULL;

CREATE TABLE `platform_release` (
    `id` VARCHAR(191) NOT NULL,
    `version` VARCHAR(64) NOT NULL,
    `sourceSha` CHAR(40) NOT NULL,
    `classification` ENUM('IMPLEMENTATION_ONLY', 'CONTRACT_CHANGE', 'CONTRACT_ADDITION') NOT NULL,
    `approval` ENUM('FLEET_APPROVED') NOT NULL,
    `contractRevision` CHAR(64) NOT NULL,
    `manifest` JSON NOT NULL,
    `manifestDigest` CHAR(64) NOT NULL,
    `signature` CHAR(64) NOT NULL,
    `publishedAt` DATETIME(3) NOT NULL,
    `observedBy` VARCHAR(191) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `platform_release_version_key`(`version`),
    UNIQUE INDEX `platform_release_manifestDigest_key`(`manifestDigest`),
    UNIQUE INDEX `platform_release_idempotencyKey_key`(`idempotencyKey`),
    INDEX `platform_release_approval_publishedAt_idx`(`approval`, `publishedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `platform_fleet_binding`
    ADD COLUMN `platformReleaseId` VARCHAR(191) NULL,
    ADD COLUMN `observedDigest` CHAR(64) NULL,
    ADD COLUMN `approvedDigest` CHAR(64) NULL,
    ADD COLUMN `manifestDigest` CHAR(64) NULL,
    ADD COLUMN `latestPlanKind` VARCHAR(32) NULL,
    ADD COLUMN `pullRequestNumber` INTEGER NULL,
    ADD COLUMN `pullRequestUrl` VARCHAR(512) NULL,
    ADD COLUMN `issueNumber` INTEGER NULL,
    ADD COLUMN `issueUrl` VARCHAR(512) NULL;

CREATE INDEX `platform_fleet_binding_platformReleaseId_state_idx`
    ON `platform_fleet_binding`(`platformReleaseId`, `state`);

CREATE TABLE `platform_fleet_plan` (
    `id` VARCHAR(191) NOT NULL,
    `platformReleaseId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `discoveryObservationId` VARCHAR(191) NOT NULL,
    `providerObservationId` VARCHAR(191) NOT NULL,
    `agentRunId` VARCHAR(191) NULL,
    `sourceSha` CHAR(40) NOT NULL,
    `kind` ENUM('SDK_UPDATE_PR', 'CONTRACT_ISSUE', 'CUSTOM_UNMANAGED', 'MISSING_UNMANAGED', 'COMPLIANT') NOT NULL,
    `status` ENUM('PENDING', 'QUEUED', 'PROCESSING', 'PR_OPEN', 'PR_MERGED', 'ISSUE_OPEN', 'COMPLIANT', 'UNMANAGED', 'READBACK_REQUIRED', 'BLOCKED', 'SUPERSEDED') NOT NULL DEFAULT 'PENDING',
    `desired` JSON NOT NULL,
    `desiredHash` CHAR(64) NOT NULL,
    `workKey` VARCHAR(191) NOT NULL,
    `mutationMarker` VARCHAR(191) NOT NULL,
    `githubNumber` INTEGER NULL,
    `githubUrl` VARCHAR(512) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `readbackRequestedAt` DATETIME(3) NULL,
    `appliedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `platform_fleet_plan_agentRunId_key`(`agentRunId`),
    UNIQUE INDEX `platform_fleet_plan_workKey_key`(`workKey`),
    UNIQUE INDEX `platform_fleet_plan_mutationMarker_key`(`mutationMarker`),
    UNIQUE INDEX `platform_fleet_plan_platformReleaseId_appId_key`(`platformReleaseId`, `appId`),
    INDEX `platform_fleet_plan_status_updatedAt_idx`(`status`, `updatedAt`),
    INDEX `platform_fleet_plan_appId_createdAt_idx`(`appId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `platform_fleet_reconcile_run` (
    `id` VARCHAR(191) NOT NULL,
    `platformReleaseId` VARCHAR(191) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'RUNNING',
    `result` JSON NULL,
    `actor` VARCHAR(191) NOT NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `platform_fleet_reconcile_run_idempotencyKey_key`(`idempotencyKey`),
    INDEX `platform_fleet_reconcile_run_platformReleaseId_createdAt_idx`(`platformReleaseId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `platform_fleet_binding`
    ADD CONSTRAINT `platform_fleet_binding_platformReleaseId_fkey`
    FOREIGN KEY (`platformReleaseId`) REFERENCES `platform_release`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `platform_fleet_plan`
    ADD CONSTRAINT `platform_fleet_plan_platformReleaseId_fkey`
    FOREIGN KEY (`platformReleaseId`) REFERENCES `platform_release`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `platform_fleet_plan_appId_fkey`
    FOREIGN KEY (`appId`) REFERENCES `app`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `platform_fleet_plan_discoveryObservationId_fkey`
    FOREIGN KEY (`discoveryObservationId`) REFERENCES `control_plane_discovery_observation`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `platform_fleet_plan_providerObservationId_fkey`
    FOREIGN KEY (`providerObservationId`) REFERENCES `control_plane_provider_observation`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `platform_fleet_plan_agentRunId_fkey`
    FOREIGN KEY (`agentRunId`) REFERENCES `agent_run`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `platform_fleet_reconcile_run`
    ADD CONSTRAINT `platform_fleet_reconcile_run_platformReleaseId_fkey`
    FOREIGN KEY (`platformReleaseId`) REFERENCES `platform_release`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
