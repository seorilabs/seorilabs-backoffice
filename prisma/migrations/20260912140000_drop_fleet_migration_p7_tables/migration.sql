-- P7 이관 전 인벤토리 표를 제거한다.
--
-- 앞선 20260912120000_drop_fleet_migration_p7 은 첫 문장(CREATE TRIGGER)에서 오류 1419로
-- 멈췄다. 배포의 migration 사용자에게는 SUPER가 없고 binary logging이 켜져 있다. 그 migration은
-- activeRecovery로 정리하고, 실제 제거는 권한이 필요 없는 문장만으로 여기서 다시 한다.
--
-- 살아 있는 legacy config resolution trigger 설치는 trusted operator Job이 맡는다
-- (k8s/operator-append-only-triggers-job.yaml).
--
-- append-only trigger를 먼저 없앤다. 남겨 두면 표 제거가 막힌다.
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
