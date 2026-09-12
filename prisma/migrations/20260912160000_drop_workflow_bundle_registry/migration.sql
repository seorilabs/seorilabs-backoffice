-- WorkflowBundle v5 승인 레지스트리를 제거한다.
--
-- 이 표는 저장소 CI를 승인 사이클에 묶던 유일한 근거였다. 번들을 읽던 워크플로, 후보
-- 실행기, caller 반증기가 모두 사라져 이 표를 읽고 쓰는 코드가 없다. 다른 표에서 이
-- 표를 참조하는 외래키도 없다.
--
-- DROP TABLE은 표에 걸린 trigger를 함께 없애고 TRIGGER 권한을 요구하지 않는다.
DROP TABLE IF EXISTS `control_plane_workflow_bundle_registry`;
