CREATE TABLE `control_plane_fleet_migration_authoritative_issuance` (
  `id` VARCHAR(191) NOT NULL,
  `occurrenceId` VARCHAR(191) NOT NULL,
  `runId` VARCHAR(127) NOT NULL,
  `providerVectorDigest` VARCHAR(71) NOT NULL,
  `inventoryId` VARCHAR(127) NOT NULL,
  `inventoryDigest` VARCHAR(71) NOT NULL,
  `issuanceDigest` VARCHAR(71) NOT NULL,
  `keyFingerprint` VARCHAR(71) NOT NULL,
  `signedAt` DATETIME(3) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `issuance` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `cp_fleet_migration_issuance_occurrence_key` (`occurrenceId`),
  UNIQUE INDEX `cp_fleet_migration_issuance_inventory_id_key` (`inventoryId`),
  UNIQUE INDEX `cp_fleet_migration_issuance_inventory_digest_key` (`inventoryDigest`),
  UNIQUE INDEX `cp_fleet_migration_issuance_digest_key` (`issuanceDigest`),
  UNIQUE INDEX `cp_fleet_migration_issuance_identity_key` (`occurrenceId`, `runId`, `providerVectorDigest`, `inventoryDigest`),
  INDEX `cp_fleet_migration_issuance_expiry_idx` (`expiresAt`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `cp_fleet_migration_issuance_completion_fkey`
    FOREIGN KEY (`occurrenceId`)
    REFERENCES `control_plane_fleet_migration_collection_completion` (`occurrenceId`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
