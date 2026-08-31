-- Org 종합 지표 보고서 일일 스냅샷. 발행 당시 문서(JSON)와 날짜 목록용 발췌값을 보존한다.
CREATE TABLE `org_report_daily` (
    `id` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `schemaVersion` INTEGER NOT NULL,
    `report` JSON NOT NULL,
    `ga4Dau` INTEGER NOT NULL DEFAULT 0,
    `consoleIaaKrw` DOUBLE NOT NULL DEFAULT 0,
    `consoleIapKrw` DOUBLE NOT NULL DEFAULT 0,
    `highlightCount` INTEGER NOT NULL DEFAULT 0,
    `lowlightCount` INTEGER NOT NULL DEFAULT 0,
    `consoleLagDays` INTEGER NULL,
    `narrated` BOOLEAN NOT NULL DEFAULT false,
    `generatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `org_report_daily_date_key`(`date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
