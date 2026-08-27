-- CreateTable
CREATE TABLE `control_plane_build_target` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `targetKey` VARCHAR(191) NOT NULL,
    `stack` VARCHAR(191) NOT NULL,
    `market` VARCHAR(191) NULL,
    `packageId` VARCHAR(191) NULL,
    `bundleId` VARCHAR(191) NULL,
    `observedSha` CHAR(40) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `configuration` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `control_plane_build_target_appId_observedSha_idx`(`appId`, `observedSha`),
    UNIQUE INDEX `control_plane_build_target_appId_targetKey_key`(`appId`, `targetKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_external_binding` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `bindingType` VARCHAR(191) NOT NULL,
    `externalId` VARCHAR(191) NOT NULL,
    `publicIdentity` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `control_plane_external_binding_appId_provider_idx`(`appId`, `provider`),
    UNIQUE INDEX `control_plane_external_binding_provider_bindingType_external_key`(`provider`, `bindingType`, `externalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_discovery_observation` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `sourceSha` CHAR(40) NOT NULL,
    `sourceRef` VARCHAR(191) NULL,
    `payload` JSON NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `observedBy` VARCHAR(191) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `control_plane_discovery_observation_idempotencyKey_key`(`idempotencyKey`),
    INDEX `control_plane_discovery_observation_appId_sourceSha_payloadH_idx`(`appId`, `sourceSha`, `payloadHash`),
    INDEX `control_plane_discovery_observation_appId_observedAt_idx`(`appId`, `observedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_config_revision` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'ACTIVE', 'SUPERSEDED') NOT NULL DEFAULT 'DRAFT',
    `payload` JSON NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `createdBy` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `activeSlot` VARCHAR(191) NULL,
    `activationIdempotencyKey` VARCHAR(191) NULL,
    `activatedSnapshot` JSON NULL,
    `snapshotDigest` CHAR(64) NULL,
    `snapshotSignature` CHAR(64) NULL,
    `activatedAt` DATETIME(3) NULL,
    `supersededAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `control_plane_config_revision_idempotencyKey_key`(`idempotencyKey`),
    UNIQUE INDEX `control_plane_config_revision_activeSlot_key`(`activeSlot`),
    UNIQUE INDEX `control_plane_config_revision_activationIdempotencyKey_key`(`activationIdempotencyKey`),
    INDEX `control_plane_config_revision_appId_status_idx`(`appId`, `status`),
    UNIQUE INDEX `control_plane_config_revision_appId_revision_key`(`appId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_provider_observation` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `resourceType` VARCHAR(191) NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `observedBy` VARCHAR(191) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `control_plane_provider_observation_idempotencyKey_key`(`idempotencyKey`),
    INDEX `control_plane_provider_observation_appId_provider_observedAt_idx`(`appId`, `provider`, `observedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_release_candidate` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `sourceSha` CHAR(40) NOT NULL,
    `configRevisionId` VARCHAR(191) NOT NULL,
    `artifactChecksum` CHAR(64) NOT NULL,
    `status` ENUM('PREPARED', 'READY', 'BLOCKED', 'SUPERSEDED') NOT NULL DEFAULT 'PREPARED',
    `createdBy` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `control_plane_release_candidate_appId_status_createdAt_idx`(`appId`, `status`, `createdAt`),
    UNIQUE INDEX `control_plane_release_candidate_appId_sourceSha_configRevisi_key`(`appId`, `sourceSha`, `configRevisionId`, `artifactChecksum`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_release_gate_observation` (
    `id` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `gate` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'PASSED', 'FAILED', 'HUMAN_REQUIRED') NOT NULL,
    `evidence` JSON NULL,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `observedBy` VARCHAR(191) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `control_plane_release_gate_observation_dedupeKey_key`(`dedupeKey`),
    INDEX `control_plane_release_gate_observation_candidateId_gate_obse_idx`(`candidateId`, `gate`, `observedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_fleet_binding` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `observedVersion` VARCHAR(191) NULL,
    `approvedVersion` VARCHAR(191) NULL,
    `contractRevision` VARCHAR(191) NULL,
    `state` VARCHAR(191) NOT NULL,
    `sourceSha` CHAR(40) NULL,
    `exceptionExpiresAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `platform_fleet_binding_appId_key`(`appId`),
    INDEX `platform_fleet_binding_state_exceptionExpiresAt_idx`(`state`, `exceptionExpiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `repository_registration` (
    `repoId` BIGINT NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `defaultBranch` VARCHAR(191) NULL,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('REGISTERED', 'NEEDS_INPUT', 'MANAGED', 'ARCHIVED') NOT NULL DEFAULT 'REGISTERED',
    `discoveryCandidates` JSON NULL,
    `lastDefaultPushSha` CHAR(40) NULL,
    `lastDeliveryId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `repository_registration_repoFullName_key`(`repoFullName`),
    INDEX `repository_registration_status_updatedAt_idx`(`status`, `updatedAt`),
    PRIMARY KEY (`repoId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_definition` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `template` VARCHAR(191) NOT NULL,
    `schedule` VARCHAR(191) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `maxAttempts` INTEGER NOT NULL DEFAULT 3,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `automation_definition_key_key`(`key`),
    INDEX `automation_definition_enabled_idx`(`enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_occurrence` (
    `id` VARCHAR(191) NOT NULL,
    `definitionId` VARCHAR(191) NOT NULL,
    `scheduledFor` DATETIME(3) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD_LETTER') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    UNIQUE INDEX `automation_occurrence_idempotencyKey_key`(`idempotencyKey`),
    INDEX `automation_occurrence_status_scheduledFor_idx`(`status`, `scheduledFor`),
    UNIQUE INDEX `automation_occurrence_definitionId_scheduledFor_key`(`definitionId`, `scheduledFor`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_run` (
    `id` VARCHAR(191) NOT NULL,
    `occurrenceId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NULL,
    `issueState` VARCHAR(191) NULL,
    `labels` JSON NOT NULL,
    `createsPr` BOOLEAN NOT NULL DEFAULT true,
    `priority` INTEGER NOT NULL DEFAULT 100,
    `status` ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `leaseGeneration` INTEGER NOT NULL DEFAULT 0,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER NOT NULL DEFAULT 3,
    `eligibleAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `outcome` JSON NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `agent_run_status_eligibleAt_priority_idx`(`status`, `eligibleAt`, `priority`),
    INDEX `agent_run_repoFullName_status_idx`(`repoFullName`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_lease` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `generation` INTEGER NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `workerId` VARCHAR(191) NOT NULL,
    `scopeKey` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `heartbeatAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `agent_lease_scopeKey_key`(`scopeKey`),
    INDEX `agent_lease_workerId_expiresAt_idx`(`workerId`, `expiresAt`),
    UNIQUE INDEX `agent_lease_runId_generation_key`(`runId`, `generation`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_run_event` (
    `id` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NULL,
    `runId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `generation` INTEGER NULL,
    `actor` VARCHAR(191) NOT NULL,
    `payload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `agent_run_event_requestId_key`(`requestId`),
    INDEX `agent_run_event_runId_createdAt_idx`(`runId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `control_plane_build_target` ADD CONSTRAINT `control_plane_build_target_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_external_binding` ADD CONSTRAINT `control_plane_external_binding_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_discovery_observation` ADD CONSTRAINT `control_plane_discovery_observation_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_config_revision` ADD CONSTRAINT `control_plane_config_revision_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_provider_observation` ADD CONSTRAINT `control_plane_provider_observation_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_release_candidate` ADD CONSTRAINT `control_plane_release_candidate_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_release_candidate` ADD CONSTRAINT `control_plane_release_candidate_configRevisionId_fkey` FOREIGN KEY (`configRevisionId`) REFERENCES `control_plane_config_revision`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_release_gate_observation` ADD CONSTRAINT `control_plane_release_gate_observation_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `control_plane_release_candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `platform_fleet_binding` ADD CONSTRAINT `platform_fleet_binding_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `automation_definition` ADD CONSTRAINT `automation_definition_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `automation_occurrence` ADD CONSTRAINT `automation_occurrence_definitionId_fkey` FOREIGN KEY (`definitionId`) REFERENCES `automation_definition`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_run` ADD CONSTRAINT `agent_run_occurrenceId_fkey` FOREIGN KEY (`occurrenceId`) REFERENCES `automation_occurrence`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_run` ADD CONSTRAINT `agent_run_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_lease` ADD CONSTRAINT `agent_lease_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `agent_run`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_run_event` ADD CONSTRAINT `agent_run_event_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `agent_run`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
