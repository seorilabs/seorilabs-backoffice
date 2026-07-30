-- 앱 운영 요청을 GitHub Actions 대신 Kubernetes worker가 처리하는 단기 큐.
CREATE TABLE `app_operation_run` (
    `id` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `operation` VARCHAR(191) NOT NULL,
    `intent` VARCHAR(191) NOT NULL,
    `params` JSON NULL,
    `reason` TEXT NULL,
    `actorLogin` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `summary` TEXT NULL,
    `result` JSON NULL,
    `error` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `redactedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `app_operation_run_requestId_key`(`requestId`),
    INDEX `app_operation_run_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `app_operation_run_appId_createdAt_idx`(`appId`, `createdAt`),
    INDEX `app_operation_run_redactedAt_expiresAt_idx`(`redactedAt`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `app_operation_run`
    ADD CONSTRAINT `app_operation_run_appId_fkey`
    FOREIGN KEY (`appId`) REFERENCES `app`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
