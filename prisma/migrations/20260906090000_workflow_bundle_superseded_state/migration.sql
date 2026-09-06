-- 승인 registry에는 활성 WorkflowBundle이 하나만 있어야 한다. 새 승인이 들어오면
-- 직전 승인을 SUPERSEDED로 물러나게 한다. 값 추가라 기존 행은 그대로다.
ALTER TABLE `control_plane_workflow_bundle_registry`
  MODIFY COLUMN `approvalState` ENUM('CANDIDATE', 'APPROVED', 'SUPERSEDED') NOT NULL;
