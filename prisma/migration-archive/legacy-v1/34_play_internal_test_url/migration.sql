-- Play Console 내부 테스트 opt-in URL(play.google.com/apps/internaltest/<id>).
-- 패키지명에서 계산할 수 없고 Play Console 에서만 복사할 수 있어 백오피스에서 직접 입력한다.
-- 시드는 이 컬럼을 갱신하지 않으며, 값이 있는 앱만 Play 배포 카드에 링크 버튼이 붙는다.
ALTER TABLE `app` ADD COLUMN `playInternalTestUrl` VARCHAR(191) NULL;
