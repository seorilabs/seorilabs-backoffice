-- ConfigRevision의 중앙 cloud/market projection. 비밀값 컬럼은 두지 않는다.
CREATE TABLE `control_plane_project_blueprint` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `configRevisionId` VARCHAR(191) NOT NULL,
    `schemaVersion` INTEGER NOT NULL,
    `organizationId` VARCHAR(30) NOT NULL,
    `folderId` VARCHAR(30) NOT NULL,
    `billingAccountId` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(30) NOT NULL,
    `projectNumber` VARCHAR(30) NULL,
    `region` VARCHAR(64) NOT NULL,
    `payload` JSON NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `control_plane_project_blueprint_configRevisionId_key`(`configRevisionId`),
    UNIQUE INDEX `cp_project_blueprint_config_app_key`(`configRevisionId`, `appId`),
    INDEX `control_plane_project_blueprint_appId_createdAt_idx`(`appId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `control_plane_market_profile` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `configRevisionId` VARCHAR(191) NOT NULL,
    `market` VARCHAR(32) NOT NULL,
    `enabled` BOOLEAN NOT NULL,
    `releaseChannel` VARCHAR(32) NULL,
    `locales` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `control_plane_market_profile_appId_market_idx`(`appId`, `market`),
    UNIQUE INDEX `control_plane_market_profile_configRevisionId_market_key`(`configRevisionId`, `market`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `control_plane_market_localization` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `configRevisionId` VARCHAR(191) NOT NULL,
    `market` VARCHAR(32) NULL,
    `scopeKey` VARCHAR(64) NOT NULL,
    `locale` VARCHAR(16) NOT NULL,
    `payload` JSON NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `control_plane_market_localization_appId_locale_idx`(`appId`, `locale`),
    UNIQUE INDEX `cp_market_loc_revision_scope_locale_key`(`configRevisionId`, `scopeKey`, `locale`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `control_plane_compliance_profile` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `configRevisionId` VARCHAR(191) NOT NULL,
    `market` VARCHAR(32) NOT NULL,
    `declaration` VARCHAR(64) NOT NULL,
    `state` VARCHAR(32) NOT NULL,
    `payload` JSON NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `control_plane_compliance_profile_appId_market_state_idx`(`appId`, `market`, `state`),
    UNIQUE INDEX `cp_compliance_revision_market_decl_key`(`configRevisionId`, `market`, `declaration`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `control_plane_store_asset` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `configRevisionId` VARCHAR(191) NOT NULL,
    `market` VARCHAR(32) NULL,
    `scopeKey` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `locale` VARCHAR(16) NULL,
    `objectKey` VARCHAR(191) NOT NULL,
    `checksum` CHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `control_plane_store_asset_appId_market_kind_idx`(`appId`, `market`, `kind`),
    UNIQUE INDEX `cp_store_asset_revision_scope_kind_object_key`(`configRevisionId`, `scopeKey`, `kind`, `objectKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `control_plane_fleet_lifecycle_state` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `stage` ENUM('IDEA', 'PLANNING', 'SPEC_REVIEW', 'APPROVED', 'BUILD', 'QA', 'RELEASE_ASSETS', 'RELEASE_CANDIDATE', 'SUBMITTED', 'REVIEW', 'APPROVED_FOR_RELEASE', 'DEPLOYED', 'PUBLIC_VERIFIED', 'MONITORED') NOT NULL DEFAULT 'IDEA',
    `sourceSha` CHAR(40) NULL,
    `configRevisionId` VARCHAR(191) NULL,
    `generation` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `control_plane_fleet_lifecycle_state_appId_key`(`appId`),
    INDEX `cp_lifecycle_state_stage_updated_idx`(`stage`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `control_plane_fleet_lifecycle_event` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `fromStage` ENUM('IDEA', 'PLANNING', 'SPEC_REVIEW', 'APPROVED', 'BUILD', 'QA', 'RELEASE_ASSETS', 'RELEASE_CANDIDATE', 'SUBMITTED', 'REVIEW', 'APPROVED_FOR_RELEASE', 'DEPLOYED', 'PUBLIC_VERIFIED', 'MONITORED') NULL,
    `toStage` ENUM('IDEA', 'PLANNING', 'SPEC_REVIEW', 'APPROVED', 'BUILD', 'QA', 'RELEASE_ASSETS', 'RELEASE_CANDIDATE', 'SUBMITTED', 'REVIEW', 'APPROVED_FOR_RELEASE', 'DEPLOYED', 'PUBLIC_VERIFIED', 'MONITORED') NOT NULL,
    `sourceSha` CHAR(40) NULL,
    `configRevisionId` VARCHAR(191) NULL,
    `actor` VARCHAR(128) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `evidence` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `cp_lifecycle_event_idempotency_key`(`idempotencyKey`),
    INDEX `control_plane_fleet_lifecycle_event_appId_createdAt_idx`(`appId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 기존 candidate 원장은 유지하면서 신규 exact binding을 additive하게 도입한다.
ALTER TABLE `control_plane_release_candidate`
    ADD COLUMN `market` VARCHAR(32) NULL,
    ADD COLUMN `targetKey` VARCHAR(191) NULL,
    ADD COLUMN `artifactType` VARCHAR(32) NULL,
    ADD COLUMN `workflowBundleSha` CHAR(40) NULL,
    ADD COLUMN `platformVersion` VARCHAR(64) NULL,
    ADD COLUMN `requestHash` CHAR(64) NULL,
    ADD COLUMN `idempotencyKey` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `control_plane_release_candidate_idempotencyKey_key`
    ON `control_plane_release_candidate`(`idempotencyKey`);

ALTER TABLE `control_plane_release_gate_observation`
    ADD COLUMN `requestHash` CHAR(64) NULL;

ALTER TABLE `control_plane_release_candidate`
    DROP FOREIGN KEY `control_plane_release_candidate_configRevisionId_fkey`;

ALTER TABLE `control_plane_project_blueprint` ADD CONSTRAINT `control_plane_project_blueprint_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `control_plane_project_blueprint` ADD CONSTRAINT `cp_project_blueprint_config_app_fkey` FOREIGN KEY (`configRevisionId`, `appId`) REFERENCES `control_plane_config_revision`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `control_plane_market_profile` ADD CONSTRAINT `control_plane_market_profile_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `control_plane_market_profile` ADD CONSTRAINT `cp_market_profile_config_app_fkey` FOREIGN KEY (`configRevisionId`, `appId`) REFERENCES `control_plane_config_revision`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `control_plane_market_localization` ADD CONSTRAINT `control_plane_market_localization_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `control_plane_market_localization` ADD CONSTRAINT `cp_market_localization_config_app_fkey` FOREIGN KEY (`configRevisionId`, `appId`) REFERENCES `control_plane_config_revision`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `control_plane_compliance_profile` ADD CONSTRAINT `control_plane_compliance_profile_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `control_plane_compliance_profile` ADD CONSTRAINT `cp_compliance_profile_config_app_fkey` FOREIGN KEY (`configRevisionId`, `appId`) REFERENCES `control_plane_config_revision`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `control_plane_store_asset` ADD CONSTRAINT `control_plane_store_asset_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `control_plane_store_asset` ADD CONSTRAINT `cp_store_asset_config_app_fkey` FOREIGN KEY (`configRevisionId`, `appId`) REFERENCES `control_plane_config_revision`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `control_plane_fleet_lifecycle_state` ADD CONSTRAINT `control_plane_fleet_lifecycle_state_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `control_plane_fleet_lifecycle_state` ADD CONSTRAINT `cp_lifecycle_state_config_app_fkey` FOREIGN KEY (`configRevisionId`, `appId`) REFERENCES `control_plane_config_revision`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `control_plane_fleet_lifecycle_event` ADD CONSTRAINT `control_plane_fleet_lifecycle_event_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `control_plane_fleet_lifecycle_event` ADD CONSTRAINT `cp_lifecycle_event_config_app_fkey` FOREIGN KEY (`configRevisionId`, `appId`) REFERENCES `control_plane_config_revision`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `control_plane_release_candidate` ADD CONSTRAINT `cp_release_candidate_config_app_fkey` FOREIGN KEY (`configRevisionId`, `appId`) REFERENCES `control_plane_config_revision`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT;
