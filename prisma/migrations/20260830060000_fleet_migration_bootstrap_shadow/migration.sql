CREATE TABLE `control_plane_fleet_migration_proof_snapshot` (
  `id` VARCHAR(191) NOT NULL,
  `repositoryId` BIGINT NOT NULL,
  `repositoryFullName` VARCHAR(191) NOT NULL,
  `sourceSha` CHAR(40) NOT NULL,
  `treeSha` CHAR(40) NOT NULL,
  `blobInventoryDigest` VARCHAR(71) NOT NULL,
  `detectorSourceSha` CHAR(40) NOT NULL,
  `readinessEvidenceDigest` CHAR(64) NOT NULL,
  `candidates` JSON NOT NULL,
  `candidatesDigest` VARCHAR(71) NOT NULL,
  `observedAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `cp_fleet_migration_proof_source_key` (`repositoryId`, `sourceSha`, `treeSha`, `blobInventoryDigest`, `detectorSourceSha`),
  INDEX `cp_fleet_migration_proof_repo_time` (`repositoryId`, `observedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `control_plane_fleet_migration_collection_occurrence` (
  `id` VARCHAR(191) NOT NULL,
  `deliveryId` VARCHAR(127) NOT NULL,
  `runId` VARCHAR(127) NOT NULL,
  `providerVectorDigest` VARCHAR(71) NOT NULL,
  `inventoryDigest` VARCHAR(71) NOT NULL,
  `collectionDigest` VARCHAR(71) NULL,
  `collection` JSON NULL,
  `status` ENUM('CLAIMED', 'COMPLETED') NOT NULL DEFAULT 'CLAIMED',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completedAt` DATETIME(3) NULL,

  UNIQUE INDEX `cp_fleet_migration_occurrence_delivery` (`deliveryId`),
  INDEX `cp_fleet_migration_occurrence_vector_state` (`providerVectorDigest`, `status`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
