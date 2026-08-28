-- Repository webhook의 durable discovery 재조정 경계.
ALTER TABLE `repository_registration`
    ADD COLUMN `managementKind` ENUM('UNCLASSIFIED', 'APP', 'PLATFORM_PRODUCER') NULL,
    ADD COLUMN `reconcileGeneration` INTEGER NULL,
    ADD COLUMN `lastReconciledSha` CHAR(40) NULL,
    ADD COLUMN `lastDiscoveryReason` VARCHAR(64) NULL;

CREATE TABLE `repository_discovery_run` (
    `id` VARCHAR(191) NOT NULL,
    `repoId` BIGINT NOT NULL,
    `generation` INTEGER NOT NULL,
    `triggerDeliveryId` VARCHAR(191) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `sourceSha` CHAR(40) NULL,
    `sourceRef` VARCHAR(191) NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'MANAGED', 'NEEDS_INPUT', 'EXCLUDED', 'STALE', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `reasonCode` VARCHAR(64) NULL,
    `candidateDigest` CHAR(64) NULL,
    `observationId` VARCHAR(191) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `leaseGeneration` INTEGER NOT NULL DEFAULT 0,
    `workerId` VARCHAR(191) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `availableAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `repository_discovery_run_triggerDeliveryId_key`(`triggerDeliveryId`),
    UNIQUE INDEX `repository_discovery_run_observationId_key`(`observationId`),
    UNIQUE INDEX `repository_discovery_run_repoId_generation_key`(`repoId`, `generation`),
    INDEX `repository_discovery_run_status_availableAt_createdAt_idx`(`status`, `availableAt`, `createdAt`),
    INDEX `repository_discovery_run_repoId_createdAt_idx`(`repoId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `repository_discovery_run`
    ADD CONSTRAINT `repository_discovery_run_repoId_fkey`
    FOREIGN KEY (`repoId`) REFERENCES `repository_registration`(`repoId`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `repository_discovery_run`
    ADD CONSTRAINT `repository_discovery_run_observationId_fkey`
    FOREIGN KEY (`observationId`) REFERENCES `control_plane_discovery_observation`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
