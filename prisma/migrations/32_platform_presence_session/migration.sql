-- CreateTable
-- RPI Presence Edge의 유실 허용 latest-state projection이다.
-- GitHub mirror나 결제/사용자 원장이 아니므로 외래 키를 두지 않는다.
CREATE TABLE `platform_presence_session` (
    `app_id` VARCHAR(64) NOT NULL,
    `session_hash` CHAR(64) NOT NULL,
    `platform` VARCHAR(16) NOT NULL,
    `app_version` VARCHAR(32) NOT NULL DEFAULT '',
    `last_sequence` BIGINT NOT NULL DEFAULT 0,
    `last_seen_at` DATETIME(3) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `platform_presence_session_expires_at_idx`(`expires_at`),
    INDEX `platform_presence_session_app_id_expires_at_idx`(`app_id`, `expires_at`),
    PRIMARY KEY (`app_id`, `session_hash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
