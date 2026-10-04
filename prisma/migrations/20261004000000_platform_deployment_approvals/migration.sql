-- CreateTable
CREATE TABLE `deployment_approval` (
    `id` VARCHAR(191) NOT NULL,
    `repository` VARCHAR(191) NOT NULL,
    `runId` BIGINT NOT NULL,
    `runAttempt` INTEGER NOT NULL,
    `environmentId` BIGINT NOT NULL,
    `environment` VARCHAR(191) NOT NULL,
    `sourceSha` VARCHAR(191) NOT NULL,
    `workflow` VARCHAR(191) NOT NULL,
    `runNumber` INTEGER NOT NULL,
    `target` JSON NULL,
    `targetHash` VARCHAR(191) NULL,
    `waitingSince` DATETIME(3) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `providerState` VARCHAR(191) NOT NULL DEFAULT 'WAITING',
    `observationError` VARCHAR(191) NULL,
    `actionState` VARCHAR(191) NOT NULL DEFAULT 'IDLE',
    `actionCommandId` VARCHAR(191) NULL,
    `actorGithubId` BIGINT NULL,
    `actorLogin` VARCHAR(191) NULL,
    `decision` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `actionStartedAt` DATETIME(3) NULL,
    `initialNotifiedAt` DATETIME(3) NULL,
    `nextReminderAt` DATETIME(3) NULL,
    `reminderSequence` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `deployment_approval_actionCommandId_key`(`actionCommandId`),
    INDEX `deployment_approval_providerState_nextReminderAt_idx`(`providerState`, `nextReminderAt`),
    UNIQUE INDEX `deployment_approval_repository_runId_runAttempt_environmentI_key`(`repository`, `runId`, `runAttempt`, `environmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `discord_account_link` (
    `githubId` BIGINT NOT NULL,
    `discordUserId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `discord_account_link_discordUserId_key`(`discordUserId`),
    PRIMARY KEY (`githubId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `discord_link_code` (
    `codeHash` VARCHAR(191) NOT NULL,
    `githubId` BIGINT NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `discord_link_code_githubId_expiresAt_idx`(`githubId`, `expiresAt`),
    PRIMARY KEY (`codeHash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

