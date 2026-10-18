CREATE TABLE `org_report_preparation` (
    `id` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `document` JSON NOT NULL,
    `enrichment` JSON NULL,
    `attachment` JSON NULL,
    `preparedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `enrichedAt` DATETIME(3) NULL,
    `publishedVersion` INTEGER NULL,
    UNIQUE INDEX `org_report_preparation_date_key`(`date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
