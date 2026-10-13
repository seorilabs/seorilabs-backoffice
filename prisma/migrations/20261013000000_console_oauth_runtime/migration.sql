-- 공개 runtime 포인터를 추가한다. 기존 데이터·credential binding은 변경하지 않는다.
CREATE TABLE `console_oauth_runtime_state` (
  `credentialId` VARCHAR(191) NOT NULL,
  `generation` INTEGER NOT NULL,
  `phase` ENUM('ACTIVE','REFRESH_IN_FLIGHT') NOT NULL DEFAULT 'ACTIVE',
  `secretVersion` VARCHAR(512) NOT NULL,
  `attemptId` VARCHAR(36) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`credentialId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
