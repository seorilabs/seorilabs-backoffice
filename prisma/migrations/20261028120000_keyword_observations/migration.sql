CREATE TABLE `keyword_collection_batch` (
  `id` VARCHAR(32) NOT NULL, `sourceSha` CHAR(40) NOT NULL, `plan` JSON NOT NULL,
  `startedAt` DATETIME(3) NOT NULL, `completedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `keyword_observation` (
  `id` CHAR(64) NOT NULL, `batchId` VARCHAR(32) NOT NULL, `appId` VARCHAR(191) NOT NULL,
  `market` VARCHAR(16) NOT NULL, `source` VARCHAR(32) NOT NULL, `country` VARCHAR(2) NOT NULL,
  `language` VARCHAR(8) NOT NULL, `term` VARCHAR(100) NOT NULL, `revision` INTEGER NOT NULL,
  `sourceSha` CHAR(40) NOT NULL, `observedAt` DATETIME(3) NOT NULL, `status` VARCHAR(24) NOT NULL,
  `rank` INTEGER NULL, `resultCount` INTEGER NULL, `isBrand` BOOLEAN NOT NULL DEFAULT false, `sourceUrl` VARCHAR(2048) NOT NULL, `errorCode` VARCHAR(64) NULL,
  INDEX `keyword_observation_batchId_idx` (`batchId`),
  INDEX `keyword_observation_appId_market_country_observedAt_idx` (`appId`, `market`, `country`, `observedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
