-- CreateTable
CREATE TABLE `release_note` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `version` VARCHAR(191) NOT NULL,
    `previousVersion` VARCHAR(191) NULL,
    `headSha` VARCHAR(191) NULL,
    `compareUrl` VARCHAR(191) NULL,
    `koKR` TEXT NOT NULL,
    `enUS` TEXT NOT NULL,
    `sourceJson` JSON NULL,
    `status` ENUM('GENERATED', 'FAILED') NOT NULL DEFAULT 'GENERATED',
    `model` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `release_note_appId_createdAt_idx`(`appId`, `createdAt`),
    UNIQUE INDEX `release_note_repoFullName_version_key`(`repoFullName`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `release_note` ADD CONSTRAINT `release_note_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
