-- CreateTable
CREATE TABLE `control_plane_legacy_config_import` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `sourceSha` CHAR(40) NOT NULL,
    `sourceRef` VARCHAR(512) NULL,
    `transformVersion` VARCHAR(64) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `inputDigest` CHAR(64) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `idempotencyKey` CHAR(64) NOT NULL,
    `configRevisionId` VARCHAR(191) NULL,
    `observedBy` VARCHAR(191) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `control_plane_legacy_config_import_idempotencyKey_key`(`idempotencyKey`),
    UNIQUE INDEX `control_plane_legacy_config_import_id_appId_key`(`id`, `appId`),
    UNIQUE INDEX `control_plane_legacy_config_import_configRevisionId_appId_key`(`configRevisionId`, `appId`),
    INDEX `control_plane_legacy_config_import_appId_sourceSha_createdAt_idx`(`appId`, `sourceSha`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_legacy_config_source` (
    `id` VARCHAR(191) NOT NULL,
    `importId` VARCHAR(191) NOT NULL,
    `repoId` BIGINT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `sourceSha` CHAR(40) NULL,
    `sourceRef` VARCHAR(512) NULL,
    `sourceKind` VARCHAR(32) NOT NULL,
    `path` VARCHAR(1024) NOT NULL,
    `pathHash` CHAR(64) NOT NULL,
    `blobSha` VARCHAR(64) NULL,
    `contentSha256` CHAR(64) NULL,
    `status` VARCHAR(32) NOT NULL,
    `transformVersion` VARCHAR(64) NOT NULL,
    `parsedPayloadHash` CHAR(64) NULL,
    `errorCode` VARCHAR(64) NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `control_plane_legacy_config_source_repoId_sourceSha_idx`(`repoId`, `sourceSha`),
    UNIQUE INDEX `control_plane_legacy_config_source_importId_pathHash_key`(`importId`, `pathHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_shadow_parity_observation` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `legacyImportId` VARCHAR(191) NOT NULL,
    `configRevisionId` VARCHAR(191) NULL,
    `sourceSha` CHAR(40) NOT NULL,
    `scope` VARCHAR(64) NOT NULL,
    `contractVersion` VARCHAR(64) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `legacyDigest` CHAR(64) NULL,
    `centralDigest` CHAR(64) NULL,
    `diff` JSON NULL,
    `dedupeKey` CHAR(64) NOT NULL,
    `observedBy` VARCHAR(191) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `control_plane_shadow_parity_observation_dedupeKey_key`(`dedupeKey`),
    INDEX `control_plane_shadow_parity_observation_appId_sourceSha_obse_idx`(`appId`, `sourceSha`, `observedAt`),
    INDEX `control_plane_shadow_parity_observation_legacyImportId_obser_idx`(`legacyImportId`, `observedAt`),
    INDEX `control_plane_shadow_parity_observation_configRevisionId_obs_idx`(`configRevisionId`, `observedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `control_plane_legacy_config_import` ADD CONSTRAINT `control_plane_legacy_config_import_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CreateIndex
CREATE UNIQUE INDEX `control_plane_config_revision_id_appId_key` ON `control_plane_config_revision`(`id`, `appId`);

-- AddForeignKey
ALTER TABLE `control_plane_legacy_config_import` ADD CONSTRAINT `control_plane_legacy_config_import_configRevisionId_appId_fkey` FOREIGN KEY (`configRevisionId`, `appId`) REFERENCES `control_plane_config_revision`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `control_plane_legacy_config_source` ADD CONSTRAINT `control_plane_legacy_config_source_importId_fkey` FOREIGN KEY (`importId`) REFERENCES `control_plane_legacy_config_import`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `control_plane_shadow_parity_observation` ADD CONSTRAINT `control_plane_shadow_parity_observation_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `control_plane_shadow_parity_observation` ADD CONSTRAINT `cp_shadow_parity_import_app_fkey` FOREIGN KEY (`legacyImportId`, `appId`) REFERENCES `control_plane_legacy_config_import`(`id`, `appId`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `control_plane_shadow_parity_observation` ADD CONSTRAINT `cp_shadow_parity_config_app_fkey` FOREIGN KEY (`configRevisionId`, `appId`) REFERENCES `control_plane_config_revision`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT;
