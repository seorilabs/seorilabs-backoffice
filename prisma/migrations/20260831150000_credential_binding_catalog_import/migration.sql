-- CredentialBinding의 secret-free catalog provenance와 optimistic revision을 추가한다.
-- 기존 row는 검증 provenance를 추측하지 않고 nullable로 남긴다.
ALTER TABLE `control_plane_credential_binding`
  ADD COLUMN `revision` INTEGER NULL,
  ADD COLUMN `catalogEntryDigest` CHAR(64) NULL,
  ADD COLUMN `catalogSnapshotDigest` CHAR(64) NULL,
  ADD COLUMN `catalogContractVersion` VARCHAR(64) NULL,
  ADD COLUMN `observedBy` VARCHAR(128) NULL;

CREATE INDEX `cp_credential_binding_app_status_revision_idx`
  ON `control_plane_credential_binding`(`appId`, `status`, `revision`);
