-- CreateTable
CREATE TABLE `control_plane_auth_broker_journal_checkpoint` (
    `id` VARCHAR(191) NOT NULL,
    `journalId` VARCHAR(191) NOT NULL,
    `generation` BIGINT NOT NULL DEFAULT 0,
    `sequence` BIGINT NOT NULL DEFAULT 0,
    `checkpointDigest` CHAR(64) NOT NULL,
    `updatedBy` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `control_plane_auth_broker_journal_checkpoint_journalId_key`(`journalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_auth_broker_journal_checkpoint_event` (
    `id` VARCHAR(191) NOT NULL,
    `checkpointId` VARCHAR(191) NOT NULL,
    `journalId` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(16) NOT NULL,
    `fromGeneration` BIGINT NULL,
    `toGeneration` BIGINT NOT NULL,
    `fromSequence` BIGINT NULL,
    `toSequence` BIGINT NOT NULL,
    `fromDigest` CHAR(64) NULL,
    `toDigest` CHAR(64) NOT NULL,
    `actor` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `control_plane_auth_broker_journal_checkpoint_event_requestId_key`(`requestId`),
    INDEX `cp_auth_broker_journal_checkpoint_event_journal_created_idx`(`journalId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `control_plane_auth_broker_journal_checkpoint_event` ADD CONSTRAINT `control_plane_auth_broker_journal_checkpoint_event_checkpoi_fkey` FOREIGN KEY (`checkpointId`) REFERENCES `control_plane_auth_broker_journal_checkpoint`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 감사 원장은 애플리케이션 계정의 실수나 ORM 경로와 무관하게 append-only다.
-- migration principal에는 CREATE TRIGGER 권한이 필요하며 없으면 배포가 fail-closed한다.
CREATE TRIGGER `control_plane_auth_broker_journal_checkpoint_event_no_update`
BEFORE UPDATE ON `control_plane_auth_broker_journal_checkpoint_event`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'auth broker journal checkpoint audit is append-only';

CREATE TRIGGER `control_plane_auth_broker_journal_checkpoint_event_no_delete`
BEFORE DELETE ON `control_plane_auth_broker_journal_checkpoint_event`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'auth broker journal checkpoint audit is append-only';
