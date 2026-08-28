ALTER TABLE `control_plane_release_candidate`
    ADD COLUMN `workflowBundleDigest` CHAR(64) NULL AFTER `workflowBundleSha`;
