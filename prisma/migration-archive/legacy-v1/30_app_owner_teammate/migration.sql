-- 담당제 AI 팀원(오너) 배분 컬럼과 2026-08-26 승인된 초기 배분.
-- platform 레포는 인프라라 미배정(운영 총괄 소관), 신규 앱은 null 로 시작해
-- 총괄 순찰이 미배정 경고를 낸다. 재배분은 데이터 갱신만으로 반영된다.
ALTER TABLE `app` ADD COLUMN `ownerTeammate` VARCHAR(191) NULL;
CREATE INDEX `app_ownerTeammate_idx` ON `app`(`ownerTeammate`);

UPDATE `app` SET `ownerTeammate` = 'noeul'
WHERE `slug` IN ('happy-farm', 'crossword-puzzle', 'jomul', 'animal-chess', 'babycare');
UPDATE `app` SET `ownerTeammate` = 'iseul'
WHERE `slug` IN ('lizard-tycoon', 'slotmachine-game', 'matgo', 'merge-lizard', 'saju-reader');
UPDATE `app` SET `ownerTeammate` = 'baram'
WHERE `slug` IN ('foam-party', 'lucid-chess', 'reascend', 'immunity-war', 'vocab-swipe');
UPDATE `app` SET `ownerTeammate` = 'saebyeok'
WHERE `slug` IN ('match-picture-app', 'spiritgate-defenders', 'merge-battle', 'minimax-defense', 'trait-test-hub', 'daoewo');
UPDATE `app` SET `ownerTeammate` = 'maru'
WHERE `slug` IN ('lucid-reversi', 'alley-market-match', 'lord-ledger', 'great-voyage', 'starlit-apprentice', 'cycle-pair');
