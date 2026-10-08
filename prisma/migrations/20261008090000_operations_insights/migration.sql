-- AlterTable
ALTER TABLE `notification_delivery` ADD COLUMN `refreshRequested` BOOLEAN NULL DEFAULT false;

-- AlterTable
ALTER TABLE `ai_draft` ADD COLUMN `claimedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `app_metric_daily` ADD COLUMN `cohortUsers` INTEGER NULL,
    ADD COLUMN `d1Users` INTEGER NULL;

-- CreateTable
CREATE TABLE `source_collection_run` (
    `id` VARCHAR(191) NOT NULL,
    `source` VARCHAR(64) NOT NULL,
    `target` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `status` VARCHAR(32) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `dataThrough` DATETIME(3) NULL,
    `coverage` JSON NULL,
    `errorCode` VARCHAR(64) NULL,

    INDEX `source_collection_run_source_target_startedAt_idx`(`source`, `target`, `startedAt`),
    INDEX `source_collection_run_appId_startedAt_idx`(`appId`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `operational_signal` (
    `id` VARCHAR(191) NOT NULL,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `kind` VARCHAR(64) NOT NULL,
    `severity` VARCHAR(16) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `facts` JSON NOT NULL,
    `sourceRefs` JSON NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `operational_signal_dedupeKey_key`(`dedupeKey`),
    INDEX `operational_signal_appId_observedAt_idx`(`appId`, `observedAt`),
    INDEX `operational_signal_kind_observedAt_idx`(`kind`, `observedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `insight_document` (
    `id` VARCHAR(191) NOT NULL,
    `signalId` VARCHAR(191) NOT NULL,
    `inputHash` CHAR(64) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `persona` VARCHAR(64) NOT NULL,
    `promptVersion` INTEGER NOT NULL,
    `model` VARCHAR(100) NULL,
    `content` JSON NULL,
    `errorCode` VARCHAR(64) NULL,
    `issueDraftId` VARCHAR(191) NULL,
    `issueUrl` VARCHAR(500) NULL,
    `notificationKey` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    UNIQUE INDEX `insight_document_issueDraftId_key`(`issueDraftId`),
    UNIQUE INDEX `insight_document_notificationKey_key`(`notificationKey`),
    UNIQUE INDEX `insight_document_runId_key`(`runId`),
    INDEX `insight_document_status_createdAt_idx`(`status`, `createdAt`),
    UNIQUE INDEX `insight_document_signalId_inputHash_key`(`signalId`, `inputHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `org_report_revision` (
    `id` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `version` INTEGER NOT NULL,
    `schemaVersion` INTEGER NOT NULL,
    `report` JSON NOT NULL,
    `generatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `org_report_revision_date_version_key`(`date`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `market_observation` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `target` VARCHAR(191) NOT NULL,
    `country` VARCHAR(16) NOT NULL,
    `day` DATE NOT NULL,
    `value` JSON NOT NULL,
    `sourceUrl` VARCHAR(2048) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `market_observation_appId_day_idx`(`appId`, `day`),
    UNIQUE INDEX `market_observation_appId_kind_target_country_day_key`(`appId`, `kind`, `target`, `country`, `day`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `insight_api_request` (
    `id` VARCHAR(191) NOT NULL,
    `day` DATE NOT NULL,
    `slot` VARCHAR(32) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `insight_api_request_slot_key`(`slot`),
    INDEX `insight_api_request_day_createdAt_idx`(`day`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `insight_document` ADD CONSTRAINT `insight_document_signalId_fkey` FOREIGN KEY (`signalId`) REFERENCES `operational_signal`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 기존 최신 발행본만 이력에 보존한다. 존재하지 않은 과거 버전을 생성하지 않는다.
INSERT INTO `org_report_revision` (`id`, `date`, `version`, `schemaVersion`, `report`, `generatedAt`)
SELECT CONCAT('import-', `id`), `date`, `version`, `schemaVersion`, `report`, `generatedAt` FROM `org_report_daily`;
