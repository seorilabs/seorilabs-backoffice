-- 담당제 운영 강도 구분(2026-08-26 사용자 확정).
--
-- 개발 폐기(DEPRECATED): 기획만 있고 진행이 멈춘 미론칭 게임. visibleAppWhere 가
-- 걸러내므로 순찰·보드·멘션 도구에서 전부 빠진다.
UPDATE `app` SET `status` = 'DEPRECATED' WHERE `slug` IN ('merge-lizard', 'great-voyage');

-- 론칭 후 방치(PAUSED): 사용자는 있으나 개선 투자를 멈춘 앱. 지표 수집과 보드
-- 노출은 유지하고(analytics-collect 는 status 필터가 없다), 순찰에서 P1·P2 급
-- 발견만 채택한다. 최저가 모델을 쓰는 마루가 일괄 담당한다.
UPDATE `app`
SET `status` = 'PAUSED', `ownerTeammate` = 'maru'
WHERE `slug` IN ('vocab-swipe', 'match-picture-app', 'foam-party', 'lucid-reversi');
