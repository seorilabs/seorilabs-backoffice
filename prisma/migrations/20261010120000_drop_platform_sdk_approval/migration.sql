-- Platform SDK 승인 체계의 표를 제거한다.
--
-- SDK는 발행된 릴리스를 그대로 쓰고 각 앱은 일반 PR로 버전을 올리기로 했다(2026-10-10).
-- 이 표를 읽고 쓰는 코드는 앞선 배포(PR #450)에서 모두 걷어냈다.
--
-- DROP TABLE은 표가 가진 외래키와 trigger를 함께 없앤다. 이 네 표에는 trigger가 없고,
-- 다른 표에서 이 표들을 가리키는 외래키도 없다. platform_release를 가리키는 외래키는
-- 나머지 세 표에만 있으므로 그 셋을 먼저 지운다.
DROP TABLE IF EXISTS `platform_fleet_plan`;
DROP TABLE IF EXISTS `platform_fleet_reconcile_run`;
DROP TABLE IF EXISTS `platform_fleet_binding`;
DROP TABLE IF EXISTS `platform_release`;
