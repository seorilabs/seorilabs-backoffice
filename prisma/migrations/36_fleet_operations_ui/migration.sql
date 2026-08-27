-- CreateTable
CREATE TABLE `control_plane_credential_binding` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `logicalCredentialId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `capability` VARCHAR(191) NOT NULL,
    `environment` VARCHAR(191) NOT NULL,
    `publicIdentity` VARCHAR(191) NULL,
    `fingerprint` VARCHAR(191) NULL,
    `consumer` VARCHAR(191) NOT NULL,
    `scope` JSON NULL,
    `status` ENUM('ACTIVE', 'SUSPENDED', 'REVOKED', 'NEEDS_REAUTH') NOT NULL DEFAULT 'ACTIVE',
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `control_plane_credential_binding_appId_provider_status_idx`(`appId`, `provider`, `status`),
    UNIQUE INDEX `control_plane_credential_binding_appId_logicalCredentialId_c_key`(`appId`, `logicalCredentialId`, `capability`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_reauth_request` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NULL,
    `provider` VARCHAR(191) NOT NULL,
    `origin` VARCHAR(512) NOT NULL,
    `publicAccountId` VARCHAR(191) NOT NULL,
    `capability` VARCHAR(191) NOT NULL,
    `gate` VARCHAR(191) NOT NULL,
    `reason` TEXT NOT NULL,
    `status` ENUM('HUMAN_REAUTH_REQUIRED', 'TRUSTED_LOCAL_PENDING') NOT NULL DEFAULT 'HUMAN_REAUTH_REQUIRED',
    `generation` INTEGER NOT NULL DEFAULT 0,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `trustedLocalIdempotencyKey` VARCHAR(191) NULL,
    `requestedBy` VARCHAR(191) NOT NULL,
    `trustedLocalRequestedBy` VARCHAR(191) NULL,
    `trustedLocalRequestedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `control_plane_reauth_request_idempotencyKey_key`(`idempotencyKey`),
    UNIQUE INDEX `control_plane_reauth_request_trustedLocalIdempotencyKey_key`(`trustedLocalIdempotencyKey`),
    INDEX `control_plane_reauth_request_appId_status_createdAt_idx`(`appId`, `status`, `createdAt`),
    INDEX `control_plane_reauth_request_runId_status_idx`(`runId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `control_plane_credential_binding` ADD CONSTRAINT `control_plane_credential_binding_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_reauth_request` ADD CONSTRAINT `control_plane_reauth_request_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_reauth_request` ADD CONSTRAINT `control_plane_reauth_request_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `agent_run`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
