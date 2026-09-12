-- P7 이관 전 인벤토리 장치를 제거한다.
--
-- 인벤토리는 2026-09-12에 발급까지 끝났고 그 결과물은 얻었다. 남은 것은 장치뿐이라 걷는다.
-- fleet_cleanup 계열은 P7 발급본을 유일한 입력으로 받는 실행 팔이고 실행 이력이 없다.
--
-- append-only trigger를 먼저 없앤다. 남겨 두면 테이블 제거가 막힌다.
-- DROP은 SUPER 없이도 되지만 CREATE는 binary logging 때문에 1419로 막힌다. 그래서 살아 있는
-- legacy config resolution trigger 선언은 trusted operator Job이 맡는다
-- (k8s/operator-append-only-triggers-job.yaml).
DROP TRIGGER IF EXISTS `control_plane_fleet_migration_proof_snapshot_no_delete`;
DROP TRIGGER IF EXISTS `control_plane_fleet_migration_proof_snapshot_no_update`;
DROP TRIGGER IF EXISTS `control_plane_fleet_migration_collection_occurrence_no_delete`;
DROP TRIGGER IF EXISTS `control_plane_fleet_migration_collection_occurrence_no_update`;
DROP TRIGGER IF EXISTS `control_plane_fleet_migration_collection_completion_no_delete`;
DROP TRIGGER IF EXISTS `control_plane_fleet_migration_collection_completion_no_update`;
DROP TRIGGER IF EXISTS `control_plane_fleet_migration_authoritative_issuance_no_delete`;
DROP TRIGGER IF EXISTS `control_plane_fleet_migration_authoritative_issuance_no_update`;

-- 외래키 방향의 역순으로 없앤다.
DROP TABLE IF EXISTS `control_plane_fleet_cleanup_execution_step`;
DROP TABLE IF EXISTS `control_plane_fleet_cleanup_execution`;
DROP TABLE IF EXISTS `control_plane_fleet_cleanup_capability`;
DROP TABLE IF EXISTS `control_plane_fleet_cleanup_authority`;
DROP TABLE IF EXISTS `control_plane_fleet_migration_authoritative_issuance`;
DROP TABLE IF EXISTS `control_plane_fleet_migration_collection_completion`;
DROP TABLE IF EXISTS `control_plane_fleet_migration_collection_occurrence`;
DROP TABLE IF EXISTS `control_plane_fleet_migration_proof_snapshot`;
