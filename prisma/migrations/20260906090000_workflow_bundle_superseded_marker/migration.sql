-- 승인 registry의 활성 WorkflowBundle은 하나다. 새 승인이 들어오면 직전 승인에 물러남
-- 표시를 남긴다. approvalState enum을 넓히지 않고 nullable column만 더해서, 배포 중
-- 구버전 reader가 모르는 enum 값을 만나지 않게 한다.
ALTER TABLE `control_plane_workflow_bundle_registry`
  ADD COLUMN `supersededAt` DATETIME(3) NULL,
  ADD COLUMN `supersededByRecordId` VARCHAR(191) NULL;

CREATE INDEX `cp_workflow_bundle_registry_active_approval`
  ON `control_plane_workflow_bundle_registry` (`registryId`, `approvalState`, `supersededAt`);
