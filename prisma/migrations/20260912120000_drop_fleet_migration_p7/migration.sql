-- P7 이관 전 인벤토리 장치를 제거한다.
--
-- 인벤토리는 2026-09-12에 발급까지 끝났고 그 결과물은 얻었다. 남은 것은 장치뿐이라 걷는다.
-- fleet_cleanup 계열은 P7 발급본을 유일한 입력으로 받는 실행 팔이고 실행 이력이 없다.
--
-- legacy config resolution trigger 2개는 제거한 trusted-operator 매니페스트에만 선언돼
-- 있었다. P7이 아니라 살아 있는 표라서 선언을 여기로 옮긴다. 운영에는 이미 설치돼 있어
-- IF NOT EXISTS로 멱등하게 둔다.
CREATE TRIGGER IF NOT EXISTS `control_plane_legacy_config_resolution_no_delete` BEFORE DELETE ON `control_plane_legacy_config_resolution` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy config resolution audit is append-only';
CREATE TRIGGER IF NOT EXISTS `control_plane_legacy_config_resolution_no_update` BEFORE UPDATE ON `control_plane_legacy_config_resolution` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy config resolution audit is append-only';

-- append-only trigger를 먼저 없앤다. 남겨 두면 테이블 제거가 막힌다.
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
