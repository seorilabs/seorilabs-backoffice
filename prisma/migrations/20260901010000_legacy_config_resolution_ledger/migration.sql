-- Legacy 검토 결과를 raw field/value 없이 exact source와 중앙 상태에 묶는
-- append-only resolution ledger다. 기존 import는 자동 승인하지 않는다.
ALTER TABLE `control_plane_legacy_config_import`
  ADD COLUMN `reasonCodes` JSON NULL,
  ADD COLUMN `reasonCodesDigest` CHAR(64) NULL;

CREATE INDEX `cp_legacy_import_resolution_lookup`
  ON `control_plane_legacy_config_import`(`appId`, `sourceSha`, `transformVersion`, `reasonCodesDigest`);

CREATE TABLE `control_plane_legacy_config_resolution` (
  `id` VARCHAR(191) NOT NULL,
  `appId` VARCHAR(191) NOT NULL,
  `sourceImportId` VARCHAR(191) NOT NULL,
  `configRevisionId` VARCHAR(191) NOT NULL,
  `sourceSha` CHAR(40) NOT NULL,
  `transformVersion` VARCHAR(64) NOT NULL,
  `inputDigest` CHAR(64) NOT NULL,
  `reasonCodes` JSON NOT NULL,
  `reasonCodesDigest` CHAR(64) NOT NULL,
  `centralStateDigest` CHAR(64) NOT NULL,
  `centralEvidenceKinds` JSON NOT NULL,
  `dispositions` JSON NOT NULL,
  `dispositionDigest` CHAR(64) NOT NULL,
  `revision` INTEGER NOT NULL,
  `approvalKind` VARCHAR(32) NOT NULL,
  `justification` VARCHAR(64) NOT NULL,
  `requestHash` CHAR(64) NOT NULL,
  `resolutionDigest` CHAR(64) NOT NULL,
  `idempotencyKey` VARCHAR(191) NOT NULL,
  `createdBy` VARCHAR(128) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `control_plane_legacy_config_resolution_resolutionDigest_key` (`resolutionDigest`),
  UNIQUE INDEX `control_plane_legacy_config_resolution_idempotencyKey_key` (`idempotencyKey`),
  UNIQUE INDEX `cp_legacy_resolution_revision_key` (`appId`, `sourceSha`, `transformVersion`, `revision`),
  INDEX `cp_legacy_resolution_exact_lookup` (`appId`, `sourceSha`, `transformVersion`, `inputDigest`, `reasonCodesDigest`),
  INDEX `cp_legacy_resolution_central_lookup` (`configRevisionId`, `centralStateDigest`),
  PRIMARY KEY (`id`),
  CONSTRAINT `cp_legacy_resolution_app_fkey`
    FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `cp_legacy_resolution_import_app_fkey`
    FOREIGN KEY (`sourceImportId`, `appId`)
    REFERENCES `control_plane_legacy_config_import`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `cp_legacy_resolution_config_app_fkey`
    FOREIGN KEY (`configRevisionId`, `appId`)
    REFERENCES `control_plane_config_revision`(`id`, `appId`) ON DELETE RESTRICT ON UPDATE RESTRICT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `control_plane_shadow_parity_observation`
  ADD COLUMN `legacyConfigResolutionId` VARCHAR(191) NULL;

CREATE INDEX `cp_shadow_parity_resolution_time`
  ON `control_plane_shadow_parity_observation`(`legacyConfigResolutionId`, `observedAt`);

ALTER TABLE `control_plane_shadow_parity_observation`
  ADD CONSTRAINT `cp_shadow_parity_resolution_fkey`
    FOREIGN KEY (`legacyConfigResolutionId`)
    REFERENCES `control_plane_legacy_config_resolution`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
