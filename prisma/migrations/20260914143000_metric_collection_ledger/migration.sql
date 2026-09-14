-- CreateTable
CREATE TABLE `metric_collection_ledger` (
    `id` VARCHAR(191) NOT NULL,
    `source` VARCHAR(16) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `listingId` INTEGER NOT NULL DEFAULT 0,
    `day` DATE NOT NULL,
    `state` VARCHAR(24) NOT NULL,
    `sealed` BOOLEAN NOT NULL DEFAULT false,
    `detail` TEXT NULL,
    `landedAt` DATETIME(3) NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `observations` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `metric_collection_ledger_source_day_state_idx`(`source`, `day`, `state`),
    UNIQUE INDEX `metric_collection_ledger_source_appId_listingId_day_key`(`source`, `appId`, `listingId`, `day`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `metric_collection_ledger` ADD CONSTRAINT `metric_collection_ledger_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

