-- 멘션 원문 저장. worker 재기동으로 끊긴 멘션 재시도에 사용하고 완료 시 비운다.
ALTER TABLE `teammate_run` ADD COLUMN `payload` JSON NULL;
