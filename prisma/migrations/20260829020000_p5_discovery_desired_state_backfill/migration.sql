-- Repository classification과 desired-state DRAFT backfill을 위한 expand-only migration.
-- legacy managementKind enum은 건드리지 않고 새 nullable 분류 정본을 병행한다.
ALTER TABLE `repository_registration`
    ADD COLUMN `classification` ENUM('PRODUCT_APP', 'INFRA_REPO', 'PLATFORM_PRODUCER', 'EXCLUDED') NULL,
    ADD COLUMN `discoveryContractVersion` VARCHAR(64) NULL;

ALTER TABLE `repository_discovery_run`
    ADD COLUMN `classification` ENUM('PRODUCT_APP', 'INFRA_REPO', 'PLATFORM_PRODUCER', 'EXCLUDED') NULL,
    ADD COLUMN `contractVersion` VARCHAR(64) NULL;

ALTER TABLE `control_plane_config_revision`
    ADD COLUMN `sourceObservationId` VARCHAR(191) NULL,
    ADD COLUMN `backfillContractVersion` VARCHAR(64) NULL;

CREATE UNIQUE INDEX `cp_config_revision_source_backfill_key`
    ON `control_plane_config_revision`(`appId`, `sourceObservationId`, `backfillContractVersion`);

ALTER TABLE `control_plane_config_revision`
    ADD CONSTRAINT `cp_config_revision_source_observation_fkey`
    FOREIGN KEY (`sourceObservationId`) REFERENCES `control_plane_discovery_observation`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE `control_plane_desired_state_backfill_run` (
    `id` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `contractVersion` VARCHAR(64) NOT NULL,
    `actor` VARCHAR(128) NOT NULL,
    `status` ENUM('RUNNING', 'COMPLETED', 'PARTIAL') NOT NULL DEFAULT 'RUNNING',
    `summary` JSON NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    UNIQUE INDEX `control_plane_desired_state_backfill_run_idempotencyKey_key`(`idempotencyKey`),
    INDEX `control_plane_desired_state_backfill_run_status_startedAt_idx`(`status`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
