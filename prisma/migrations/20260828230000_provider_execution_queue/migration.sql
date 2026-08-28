-- Provider 실행의 exact binding, lease CAS, readback-first, append-only audit 원장.
-- 기존 credential 행은 nullable 공개 실행 metadata를 backfill할 때까지 claim되지 않는다.
ALTER TABLE `control_plane_credential_binding`
    ADD COLUMN `credentialGeneration` INTEGER NULL,
    ADD COLUMN `policyGeneration` INTEGER NULL,
    ADD COLUMN `adapterId` VARCHAR(64) NULL,
    ADD COLUMN `origin` VARCHAR(512) NULL,
    ADD COLUMN `authFactors` JSON NULL;

CREATE TABLE `control_plane_provider_execution` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `repoId` BIGINT NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `sourceSha` CHAR(40) NOT NULL,
    `configRevisionId` VARCHAR(191) NOT NULL,
    `configRevisionNumber` INTEGER NOT NULL,
    `releaseCandidateId` VARCHAR(191) NULL,
    `kind` ENUM('BLUEPRINT_RESOURCE', 'MARKET_RELEASE') NOT NULL,
    `operation` ENUM('READBACK', 'APPLY', 'UPLOAD_INTERNAL') NOT NULL,
    `actionClass` ENUM('READ_ONLY', 'DETERMINISTIC_MUTATION', 'PROTECTED_MUTATION', 'INTERNAL_UPLOAD', 'HUMAN_ONLY') NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `resourceType` VARCHAR(64) NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    `desiredHash` CHAR(64) NOT NULL,
    `desiredPayload` JSON NOT NULL,
    `expectedPublicIdentity` VARCHAR(512) NULL,
    `publicAccountId` VARCHAR(191) NOT NULL,
    `credentialPublicIdentity` VARCHAR(512) NOT NULL,
    `logicalCredentialId` VARCHAR(191) NOT NULL,
    `credentialGeneration` INTEGER NOT NULL,
    `policyGeneration` INTEGER NOT NULL,
    `capability` VARCHAR(191) NOT NULL,
    `adapterId` VARCHAR(64) NOT NULL,
    `origin` VARCHAR(512) NOT NULL,
    `environment` VARCHAR(64) NOT NULL,
    `authFactors` JSON NOT NULL,
    `readbackPublicAccountId` VARCHAR(191) NOT NULL,
    `readbackCredentialPublicIdentity` VARCHAR(512) NOT NULL,
    `readbackLogicalCredentialId` VARCHAR(191) NOT NULL,
    `readbackCredentialGeneration` INTEGER NOT NULL,
    `readbackPolicyGeneration` INTEGER NOT NULL,
    `readbackCapability` VARCHAR(191) NOT NULL,
    `readbackAdapterId` VARCHAR(64) NOT NULL,
    `readbackOrigin` VARCHAR(512) NOT NULL,
    `readbackEnvironment` VARCHAR(64) NOT NULL,
    `readbackAuthFactors` JSON NOT NULL,
    `artifactChecksum` CHAR(64) NULL,
    `bindingHash` CHAR(64) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `status` ENUM('QUEUED', 'WAITING_HUMAN_APPROVAL', 'HUMAN_ONLY_BLOCKED', 'RUNNING', 'READBACK_REQUIRED', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `activeScopeKey` VARCHAR(191) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `readbackAttempts` INTEGER NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER NOT NULL DEFAULT 3,
    `leaseGeneration` INTEGER NOT NULL DEFAULT 0,
    `leaseTokenHash` CHAR(64) NULL,
    `workerId` VARCHAR(128) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `availableAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `readbackRequiredAt` DATETIME(3) NULL,
    `approvedBy` VARCHAR(128) NULL,
    `approvalId` VARCHAR(191) NULL,
    `approvalBindingHash` CHAR(64) NULL,
    `approvalExpiresAt` DATETIME(3) NULL,
    `lastObservationId` VARCHAR(191) NULL,
    `lastErrorCode` VARCHAR(128) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `control_plane_provider_execution_idempotencyKey_key`(`idempotencyKey`),
    UNIQUE INDEX `control_plane_provider_execution_activeScopeKey_key`(`activeScopeKey`),
    UNIQUE INDEX `cp_provider_execution_id_app_key`(`id`, `appId`),
    INDEX `control_plane_provider_execution_status_availableAt_createdAt_idx`(`status`, `availableAt`, `createdAt`),
    INDEX `control_plane_provider_execution_appId_createdAt_idx`(`appId`, `createdAt`),
    INDEX `control_plane_provider_execution_repoId_sourceSha_configRevisionNumber_idx`(`repoId`, `sourceSha`, `configRevisionNumber`),
    INDEX `control_plane_provider_execution_configRevisionId_appId_idx`(`configRevisionId`, `appId`),
    INDEX `control_plane_provider_execution_releaseCandidateId_idx`(`releaseCandidateId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `control_plane_provider_execution_event` (
    `id` VARCHAR(191) NOT NULL,
    `executionId` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NULL,
    `type` VARCHAR(64) NOT NULL,
    `generation` INTEGER NULL,
    `actor` VARCHAR(128) NOT NULL,
    `payload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `control_plane_provider_execution_event_requestId_key`(`requestId`),
    INDEX `control_plane_provider_execution_event_executionId_createdAt_idx`(`executionId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `control_plane_provider_execution`
    ADD CONSTRAINT `control_plane_provider_execution_appId_fkey`
    FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT `cp_provider_execution_config_app_fkey`
    FOREIGN KEY (`configRevisionId`, `appId`) REFERENCES `control_plane_config_revision`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT `control_plane_provider_execution_releaseCandidateId_fkey`
    FOREIGN KEY (`releaseCandidateId`) REFERENCES `control_plane_release_candidate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE `control_plane_provider_execution_event`
    ADD CONSTRAINT `control_plane_provider_execution_event_executionId_fkey`
    FOREIGN KEY (`executionId`) REFERENCES `control_plane_provider_execution`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 감사 원장은 애플리케이션 계정의 실수나 ORM 경로와 무관하게 append-only다.
-- migration principal에는 CREATE TRIGGER 권한이 필요하며 없으면 배포가 fail-closed한다.
CREATE TRIGGER `control_plane_provider_execution_event_no_update`
BEFORE UPDATE ON `control_plane_provider_execution_event`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'provider execution audit is append-only';

CREATE TRIGGER `control_plane_provider_execution_event_no_delete`
BEFORE DELETE ON `control_plane_provider_execution_event`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'provider execution audit is append-only';
