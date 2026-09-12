-- P7 이관 전 인벤토리 표를 제거한다.
--
-- 앞선 두 시도가 권한에서 멈췄다. 배포의 migration 사용자에게는 SUPER도 TRIGGER 권한도 없다.
-- CREATE TRIGGER는 오류 1419, DROP TRIGGER는 오류 1142로 막힌다.
--
-- DROP TABLE은 표에 걸린 trigger를 함께 없애고 TRIGGER 권한을 요구하지 않는다. MySQL 9.2에서
-- 제한 사용자로 직접 확인했다(trigger 1개가 걸린 표를 DROP TABLE 하면 trigger도 0이 된다).
-- 그래서 여기서는 DROP TABLE만 쓴다.
--
-- 살아 있는 legacy config resolution trigger 설치는 trusted operator Job이 맡는다
-- (k8s/operator-append-only-triggers-job.yaml).
--
-- 외래키 방향의 역순으로 없앤다.
DROP TABLE IF EXISTS `control_plane_fleet_cleanup_execution_step`;
DROP TABLE IF EXISTS `control_plane_fleet_cleanup_execution`;
DROP TABLE IF EXISTS `control_plane_fleet_cleanup_capability`;
DROP TABLE IF EXISTS `control_plane_fleet_cleanup_authority`;
DROP TABLE IF EXISTS `control_plane_fleet_migration_authoritative_issuance`;
DROP TABLE IF EXISTS `control_plane_fleet_migration_collection_completion`;
DROP TABLE IF EXISTS `control_plane_fleet_migration_collection_occurrence`;
DROP TABLE IF EXISTS `control_plane_fleet_migration_proof_snapshot`;
