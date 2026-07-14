-- AlterTable: 기존 ko/en 출시노트를 보존하면서 6개 언어를 추가한다.
ALTER TABLE `release_note`
    ADD COLUMN `jaJP` TEXT NULL,
    ADD COLUMN `zhCN` TEXT NULL,
    ADD COLUMN `zhTW` TEXT NULL,
    ADD COLUMN `deDE` TEXT NULL,
    ADD COLUMN `frFR` TEXT NULL,
    ADD COLUMN `esES` TEXT NULL;
