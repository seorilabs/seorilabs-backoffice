-- 승인 registry의 활성 WorkflowBundle은 하나다. 그 하나를 DB가 강제하도록 registry 단위
-- 유일 slot을 둔다. 활성 승인만 slot을 쥐고, 물러난 승인은 slot을 놓은 뒤 언제 무엇에
-- 대체됐는지 남긴다. 동시에 두 승인이 들어와도 유일 index가 하나만 통과시킨다.
--
-- approvalState enum을 넓히지 않는다. 배포 중 구버전 reader가 모르는 enum 값을 만나면
-- 조회 자체가 깨진다.
ALTER TABLE `control_plane_workflow_bundle_registry`
  ADD COLUMN `activeApprovalSlot` VARCHAR(64) NULL,
  ADD COLUMN `supersededAt` DATETIME(3) NULL,
  ADD COLUMN `supersededByRecordId` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `cp_workflow_bundle_registry_active_slot`
  ON `control_plane_workflow_bundle_registry` (`activeApprovalSlot`);
