-- Platform registry app_id를 Backoffice App에 영속적으로 결합한다.
-- GitHub registry/apps/*.json 동기화 경로만 이 값을 갱신하며 운영 DB 수동 수정은 하지 않는다.
ALTER TABLE `app`
    ADD COLUMN `platformAppId` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `app_platformAppId_key` ON `app`(`platformAppId`);
