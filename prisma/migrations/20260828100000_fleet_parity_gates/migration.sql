-- CreateTable
CREATE TABLE `control_plane_fleet_parity_wave` (
    `id` VARCHAR(191) NOT NULL,
    `occurrenceKey` CHAR(64) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `scope` VARCHAR(64) NOT NULL DEFAULT 'FULL',
    `contractVersion` VARCHAR(64) NOT NULL,
    `cohortDigest` CHAR(64) NOT NULL,
    `vectorDigest` CHAR(64) NULL,
    `evidenceDigest` CHAR(64) NULL,
    `status` ENUM('RUNNING', 'PASSED', 'BLOCKED') NOT NULL DEFAULT 'RUNNING',
    `resultCount` INTEGER NOT NULL DEFAULT 0,
    `matchCount` INTEGER NOT NULL DEFAULT 0,
    `consecutiveMatchCount` INTEGER NOT NULL DEFAULT 0,
    `cleanupAllowed` BOOLEAN NOT NULL DEFAULT false,
    `observedBy` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `control_plane_fleet_parity_wave_occurrenceKey_key`(`occurrenceKey`),
    INDEX `control_plane_fleet_parity_wave_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_fleet_parity_wave_result` (
    `id` VARCHAR(191) NOT NULL,
    `waveId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `repoId` BIGINT NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `sourceSha` CHAR(40) NULL,
    `configRevisionId` VARCHAR(191) NULL,
    `legacyImportId` VARCHAR(191) NULL,
    `parityObservationId` VARCHAR(191) NULL,
    `scope` VARCHAR(64) NOT NULL DEFAULT 'FULL',
    `contractVersion` VARCHAR(64) NOT NULL,
    `status` ENUM('PENDING', 'MATCH', 'MISMATCH', 'NEEDS_INPUT', 'ERROR') NOT NULL DEFAULT 'PENDING',
    `reasonCode` VARCHAR(64) NULL,
    `legacyDigest` CHAR(64) NULL,
    `centralDigest` CHAR(64) NULL,
    `sourceCount` INTEGER NOT NULL DEFAULT 0,
    `observedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `control_plane_fleet_parity_wave_result_appId_createdAt_idx`(`appId`, `createdAt`),
    INDEX `control_plane_fleet_parity_wave_result_status_createdAt_idx`(`status`, `createdAt`),
    UNIQUE INDEX `control_plane_fleet_parity_wave_result_waveId_appId_key`(`waveId`, `appId`),
    UNIQUE INDEX `control_plane_fleet_parity_wave_result_parityObservationId_a_key`(`parityObservationId`, `appId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `control_plane_shadow_parity_observation_id_appId_key` ON `control_plane_shadow_parity_observation`(`id`, `appId`);

-- AddForeignKey
ALTER TABLE `control_plane_fleet_parity_wave_result` ADD CONSTRAINT `control_plane_fleet_parity_wave_result_waveId_fkey` FOREIGN KEY (`waveId`) REFERENCES `control_plane_fleet_parity_wave`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `control_plane_fleet_parity_wave_result` ADD CONSTRAINT `control_plane_fleet_parity_wave_result_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `control_plane_fleet_parity_wave_result` ADD CONSTRAINT `cp_fleet_wave_result_config_app_fkey` FOREIGN KEY (`configRevisionId`, `appId`) REFERENCES `control_plane_config_revision`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `control_plane_fleet_parity_wave_result` ADD CONSTRAINT `cp_fleet_wave_result_import_app_fkey` FOREIGN KEY (`legacyImportId`, `appId`) REFERENCES `control_plane_legacy_config_import`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `control_plane_fleet_parity_wave_result` ADD CONSTRAINT `cp_fleet_wave_result_parity_app_fkey` FOREIGN KEY (`parityObservationId`, `appId`) REFERENCES `control_plane_shadow_parity_observation`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT;
