-- P6: 앱별 ProjectV2 ID 대신 조직 단일 Seorilabs Fleet desired-state binding을 둔다.
CREATE TABLE `fleet_project_binding` (
    `id` VARCHAR(64) NOT NULL,
    `organizationLogin` VARCHAR(39) NOT NULL,
    `projectNumber` INTEGER NOT NULL,
    `expectedTitle` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `projectNodeId` VARCHAR(191) NULL,
    `observedProjectNodeId` VARCHAR(191) NULL,
    `organizationNodeId` VARCHAR(191) NULL,
    `observedTitle` VARCHAR(191) NULL,
    `observedUrl` VARCHAR(2048) NULL,
    `permissionLevel` VARCHAR(16) NULL,
    `missingRequirements` JSON NULL,
    `status` ENUM('PENDING', 'VERIFIED', 'HUMAN_PERMISSION_REQUIRED', 'READBACK_REQUIRED', 'IDENTITY_MISMATCH') NOT NULL DEFAULT 'PENDING',
    `lastErrorCode` VARCHAR(96) NULL,
    `lastError` TEXT NULL,
    `observedAt` DATETIME(3) NULL,
    `verifiedAt` DATETIME(3) NULL,
    `createdBy` VARCHAR(128) NOT NULL,
    `updatedBy` VARCHAR(128) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `fleet_project_binding_status_updatedAt_idx`(`status`, `updatedAt`),
    CONSTRAINT `fleet_project_binding_singleton_chk` CHECK (`id` = 'seorilabs-fleet'),
    CONSTRAINT `fleet_project_binding_project_number_chk` CHECK (`projectNumber` > 0),
    CONSTRAINT `fleet_project_binding_revision_chk` CHECK (`revision` > 0),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 기존 projection은 중앙 binding revision이 없어 자동으로 SUPERSEDED 처리된다.
ALTER TABLE `fleet_project_projection`
    ADD COLUMN `bindingRevision` INTEGER NULL AFTER `projectNodeId`;
