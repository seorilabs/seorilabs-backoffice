CREATE TABLE `control_plane_fleet_migration_proof_snapshot` (
  `id` VARCHAR(191) NOT NULL,
  `repositoryId` BIGINT NOT NULL,
  `repositoryFullName` VARCHAR(191) NOT NULL,
  `sourceSha` CHAR(40) NOT NULL,
  `treeSha` CHAR(40) NOT NULL,
  `blobInventoryDigest` VARCHAR(71) NOT NULL,
  `detectorSourceSha` CHAR(40) NOT NULL,
  `readinessEvidenceDigest` CHAR(64) NOT NULL,
  `readinessCohortDigest` CHAR(64) NOT NULL,
  `stableBackofficeStateDigest` CHAR(64) NOT NULL,
  `candidates` JSON NOT NULL,
  `candidatesDigest` VARCHAR(71) NOT NULL,
  `proofDigest` CHAR(64) NOT NULL,
  `approvalId` VARCHAR(127) NOT NULL,
  `approvalAttestation` JSON NOT NULL,
  `approvalAttestationDigest` CHAR(64) NOT NULL,
  `idempotencyKey` VARCHAR(191) NOT NULL,
  `requestHash` CHAR(64) NOT NULL,
  `createdBy` VARCHAR(128) NOT NULL,
  `observedAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `cp_fleet_migration_proof_digest` (`proofDigest`),
  UNIQUE INDEX `cp_fleet_migration_proof_idempotency` (`idempotencyKey`),
  UNIQUE INDEX `cp_fleet_migration_proof_revision_key` (`repositoryId`, `sourceSha`, `treeSha`, `blobInventoryDigest`, `detectorSourceSha`, `readinessEvidenceDigest`, `readinessCohortDigest`, `stableBackofficeStateDigest`, `candidatesDigest`),
  INDEX `cp_fleet_migration_proof_repo_time` (`repositoryId`, `sourceSha`, `detectorSourceSha`, `observedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `control_plane_fleet_migration_collection_occurrence` (
  `id` VARCHAR(191) NOT NULL,
  `deliveryId` VARCHAR(127) NOT NULL,
  `runId` VARCHAR(127) NOT NULL,
  `providerVectorDigest` VARCHAR(71) NOT NULL,
  `inventoryDigest` VARCHAR(71) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `cp_fleet_migration_occurrence_delivery` (`deliveryId`),
  UNIQUE INDEX `cp_fleet_migration_occurrence_identity` (`id`, `deliveryId`, `runId`, `providerVectorDigest`, `inventoryDigest`),
  INDEX `cp_fleet_migration_occurrence_vector_time` (`providerVectorDigest`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `control_plane_fleet_migration_collection_completion` (
  `id` VARCHAR(191) NOT NULL,
  `occurrenceId` VARCHAR(191) NOT NULL,
  `deliveryId` VARCHAR(127) NOT NULL,
  `runId` VARCHAR(127) NOT NULL,
  `providerVectorDigest` VARCHAR(71) NOT NULL,
  `inventoryDigest` VARCHAR(71) NOT NULL,
  `collectionDigest` VARCHAR(71) NOT NULL,
  `finalGithubDigest` VARCHAR(71) NOT NULL,
  `finalBackofficeDigest` VARCHAR(71) NOT NULL,
  `finalizationDigest` VARCHAR(71) NOT NULL,
  `collection` JSON NOT NULL,
  `completedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `cp_fleet_migration_completion_occurrence_key` (`occurrenceId`),
  UNIQUE INDEX `cp_fleet_migration_completion_identity` (`occurrenceId`, `deliveryId`, `runId`, `providerVectorDigest`, `inventoryDigest`),
  INDEX `cp_fleet_migration_completion_vector_time` (`providerVectorDigest`, `completedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `cp_fleet_migration_completion_occurrence_fkey`
    FOREIGN KEY (`occurrenceId`, `deliveryId`, `runId`, `providerVectorDigest`, `inventoryDigest`)
    REFERENCES `control_plane_fleet_migration_collection_occurrence` (`id`, `deliveryId`, `runId`, `providerVectorDigest`, `inventoryDigest`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
