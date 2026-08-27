-- CreateTable
CREATE TABLE `app` (
    `id` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `repoId` BIGINT NULL,
    `type` ENUM('APP', 'GAME') NOT NULL,
    `engine` ENUM('RN', 'GODOT') NOT NULL,
    `status` ENUM('ACTIVE', 'PAUSED', 'DEPRECATED') NOT NULL DEFAULT 'ACTIVE',
    `currentStage` ENUM('PLANNING', 'DEVELOPMENT', 'QA', 'MARKET_SUBMISSION', 'RELEASE', 'LIVEOPS') NOT NULL DEFAULT 'PLANNING',
    `isPublicRepo` BOOLEAN NOT NULL DEFAULT false,
    `firebaseProject` VARCHAR(191) NULL,
    `platformAppId` VARCHAR(191) NULL,
    `ga4Dataset` VARCHAR(191) NULL,
    `platformUserBaseline` INTEGER NULL,
    `playPackage` VARCHAR(191) NULL,
    `playInternalTestUrl` VARCHAR(191) NULL,
    `iosBundle` VARCHAR(191) NULL,
    `appleTeamId` VARCHAR(191) NULL,
    `iosSku` VARCHAR(191) NULL,
    `aitAppName` VARCHAR(191) NULL,
    `aitWorkspaceId` INTEGER NULL,
    `aitMiniAppId` INTEGER NULL,
    `ownerTeammate` VARCHAR(191) NULL,
    `marketTargets` JSON NOT NULL,
    `configHash` VARCHAR(191) NULL,
    `configSyncedAt` DATETIME(3) NULL,
    `opsManifest` JSON NULL,
    `opsManifestError` TEXT NULL,
    `projectV2Id` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `app_slug_key`(`slug`),
    UNIQUE INDEX `app_repoFullName_key`(`repoFullName`),
    UNIQUE INDEX `app_repoId_key`(`repoId`),
    UNIQUE INDEX `app_platformAppId_key`(`platformAppId`),
    UNIQUE INDEX `app_playPackage_key`(`playPackage`),
    UNIQUE INDEX `app_aitMiniAppId_key`(`aitMiniAppId`),
    INDEX `app_status_currentStage_idx`(`status`, `currentStage`),
    INDEX `app_type_engine_idx`(`type`, `engine`),
    INDEX `app_ownerTeammate_idx`(`ownerTeammate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stage_transition` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `fromStage` ENUM('PLANNING', 'DEVELOPMENT', 'QA', 'MARKET_SUBMISSION', 'RELEASE', 'LIVEOPS') NULL,
    `toStage` ENUM('PLANNING', 'DEVELOPMENT', 'QA', 'MARKET_SUBMISSION', 'RELEASE', 'LIVEOPS') NOT NULL,
    `source` ENUM('BACKOFFICE', 'GITHUB', 'SYSTEM') NOT NULL,
    `actorLogin` VARCHAR(191) NULL,
    `reason` TEXT NULL,
    `signalRef` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stage_transition_appId_createdAt_idx`(`appId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `issue_mirror` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `number` INTEGER NOT NULL,
    `nodeId` VARCHAR(191) NOT NULL,
    `title` TEXT NOT NULL,
    `state` ENUM('OPEN', 'CLOSED') NOT NULL,
    `stateReason` VARCHAR(191) NULL,
    `authorLogin` VARCHAR(191) NULL,
    `assignees` JSON NOT NULL,
    `labels` JSON NOT NULL,
    `milestone` VARCHAR(191) NULL,
    `priority` ENUM('P1', 'P2', 'P3', 'P4') NULL,
    `isAutopilot` BOOLEAN NOT NULL DEFAULT false,
    `hasEvidence` BOOLEAN NOT NULL DEFAULT false,
    `isBlocked` BOOLEAN NOT NULL DEFAULT false,
    `source` ENUM('BACKOFFICE', 'CLAUDE_CODE', 'ROUTINE', 'UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
    `clientReqId` VARCHAR(191) NULL,
    `linkedPrUrl` VARCHAR(191) NULL,
    `ghCreatedAt` DATETIME(3) NOT NULL,
    `ghUpdatedAt` DATETIME(3) NOT NULL,
    `mirroredAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `issue_mirror_nodeId_key`(`nodeId`),
    UNIQUE INDEX `issue_mirror_clientReqId_key`(`clientReqId`),
    INDEX `issue_mirror_appId_state_idx`(`appId`, `state`),
    INDEX `issue_mirror_state_priority_idx`(`state`, `priority`),
    UNIQUE INDEX `issue_mirror_repoFullName_number_key`(`repoFullName`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pull_request_mirror` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `number` INTEGER NOT NULL,
    `nodeId` VARCHAR(191) NOT NULL,
    `title` TEXT NOT NULL,
    `state` ENUM('OPEN', 'CLOSED', 'MERGED') NOT NULL,
    `isDraft` BOOLEAN NOT NULL DEFAULT false,
    `authorLogin` VARCHAR(191) NULL,
    `headRef` VARCHAR(191) NULL,
    `baseRef` VARCHAR(191) NULL,
    `labels` JSON NOT NULL,
    `linkedIssue` INTEGER NULL,
    `isAutopilotPr` BOOLEAN NOT NULL DEFAULT false,
    `mergedAt` DATETIME(3) NULL,
    `ghCreatedAt` DATETIME(3) NOT NULL,
    `ghUpdatedAt` DATETIME(3) NOT NULL,
    `mirroredAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `pull_request_mirror_nodeId_key`(`nodeId`),
    INDEX `pull_request_mirror_appId_state_idx`(`appId`, `state`),
    UNIQUE INDEX `pull_request_mirror_repoFullName_number_key`(`repoFullName`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workflow_run_mirror` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `runId` BIGINT NOT NULL,
    `name` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL,
    `conclusion` VARCHAR(191) NULL,
    `event` VARCHAR(191) NULL,
    `headSha` VARCHAR(191) NULL,
    `headBranch` VARCHAR(191) NULL,
    `runAttempt` INTEGER NOT NULL DEFAULT 1,
    `runStartedAt` DATETIME(3) NULL,
    `ghUpdatedAt` DATETIME(3) NOT NULL,
    `mirroredAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `workflow_run_mirror_runId_key`(`runId`),
    INDEX `workflow_run_mirror_appId_name_idx`(`appId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `release_record` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `version` VARCHAR(191) NOT NULL,
    `market` ENUM('PLAY', 'APPSTORE', 'AIT', 'WEB') NOT NULL,
    `track` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK') NOT NULL DEFAULT 'PENDING',
    `workflowRunId` BIGINT NULL,
    `workflowName` VARCHAR(191) NULL,
    `externalRunId` VARCHAR(191) NULL,
    `externalBuildNumber` INTEGER NULL,
    `commitSha` VARCHAR(191) NULL,
    `triggeredBy` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NULL,
    `deployedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `release_record_externalRunId_key`(`externalRunId`),
    INDEX `release_record_appId_market_deployedAt_idx`(`appId`, `market`, `deployedAt`),
    UNIQUE INDEX `release_record_market_workflowRunId_key`(`market`, `workflowRunId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_event` (
    `id` VARCHAR(191) NOT NULL,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `kind` ENUM('DEPLOY_COMPLETION', 'DAILY_METRICS', 'OPERATIONS_SUMMARY', 'OPERATIONAL_EVENT', 'OPS_ALERT', 'EXTERNAL_FEED', 'MILESTONE', 'INCIDENT', 'STORE_REVIEW', 'IDENTITY_SUMMARY', 'IDENTITY_ROW') NOT NULL,
    `payload` JSON NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `notification_event_dedupeKey_key`(`dedupeKey`),
    INDEX `notification_event_kind_occurredAt_idx`(`kind`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_delivery` (
    `id` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `provider` ENUM('DISCORD') NOT NULL,
    `destinationKey` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SENT', 'DEAD_LETTER') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastError` TEXT NULL,
    `providerMessageId` VARCHAR(191) NULL,
    `sentAt` DATETIME(3) NULL,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `notification_delivery_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    UNIQUE INDEX `notification_delivery_eventId_provider_destinationKey_key`(`eventId`, `provider`, `destinationKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `operational_event` (
    `eventId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `outcome` VARCHAR(191) NOT NULL,
    `attributes` JSON NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `operational_event_occurredAt_idx`(`occurredAt`),
    INDEX `operational_event_appId_eventType_occurredAt_idx`(`appId`, `eventType`, `occurredAt`),
    PRIMARY KEY (`eventId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `operator_command_run` (
    `id` VARCHAR(191) NOT NULL,
    `sourceInteractionId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `operation` VARCHAR(191) NOT NULL,
    `params` JSON NULL,
    `actorDiscordUserId` VARCHAR(191) NOT NULL,
    `actorLabel` VARCHAR(191) NOT NULL,
    `channelId` VARCHAR(191) NOT NULL,
    `messageId` VARCHAR(191) NULL,
    `status` ENUM('AWAITING_CONFIRMATION', 'PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'AWAITING_CONFIRMATION',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `summary` TEXT NULL,
    `error` TEXT NULL,
    `confirmedAt` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `redactedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `operator_command_run_sourceInteractionId_key`(`sourceInteractionId`),
    INDEX `operator_command_run_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `operator_command_run_redactedAt_expiresAt_idx`(`redactedAt`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `operational_incident` (
    `id` VARCHAR(191) NOT NULL,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `source` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `severity` VARCHAR(191) NOT NULL,
    `status` ENUM('OPEN', 'ACKNOWLEDGED', 'RECOVERED') NOT NULL DEFAULT 'OPEN',
    `summary` TEXT NOT NULL,
    `evidence` JSON NULL,
    `destinationKey` VARCHAR(191) NOT NULL DEFAULT 'ops-alerts',
    `providerMessageId` VARCHAR(191) NULL,
    `acknowledgedBy` VARCHAR(191) NULL,
    `acknowledgedAt` DATETIME(3) NULL,
    `assignedDiscordUserId` VARCHAR(191) NULL,
    `firstDetectedAt` DATETIME(3) NOT NULL,
    `lastDetectedAt` DATETIME(3) NOT NULL,
    `recoveredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `operational_incident_dedupeKey_key`(`dedupeKey`),
    INDEX `operational_incident_status_severity_lastDetectedAt_idx`(`status`, `severity`, `lastDetectedAt`),
    INDEX `operational_incident_appId_status_idx`(`appId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `operational_milestone` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `firstEventId` VARCHAR(191) NOT NULL,
    `firstObservedAt` DATETIME(3) NOT NULL,
    `notifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `operational_milestone_appId_eventType_key`(`appId`, `eventType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `store_review_sync` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `store` ENUM('GOOGLE_PLAY', 'APP_STORE') NOT NULL,
    `initializedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSuccessfulAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `store_review_sync_store_lastSuccessfulAt_idx`(`store`, `lastSuccessfulAt`),
    UNIQUE INDEX `store_review_sync_appId_store_key`(`appId`, `store`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `store_review_observation` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `store` ENUM('GOOGLE_PLAY', 'APP_STORE') NOT NULL,
    `externalReviewId` VARCHAR(191) NOT NULL,
    `rating` INTEGER NOT NULL,
    `contentHash` VARCHAR(191) NOT NULL,
    `notifiedHash` VARCHAR(191) NULL,
    `sourceCreatedAt` DATETIME(3) NULL,
    `sourceModifiedAt` DATETIME(3) NULL,
    `firstObservedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastObservedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `store_review_observation_appId_store_sourceModifiedAt_idx`(`appId`, `store`, `sourceModifiedAt`),
    UNIQUE INDEX `store_review_observation_appId_store_externalReviewId_key`(`appId`, `store`, `externalReviewId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_operation_run` (
    `id` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `operation` VARCHAR(191) NOT NULL,
    `intent` VARCHAR(191) NOT NULL,
    `params` JSON NULL,
    `reason` TEXT NULL,
    `actorLogin` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `summary` TEXT NULL,
    `result` JSON NULL,
    `error` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `redactedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `app_operation_run_requestId_key`(`requestId`),
    INDEX `app_operation_run_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `app_operation_run_appId_createdAt_idx`(`appId`, `createdAt`),
    INDEX `app_operation_run_redactedAt_expiresAt_idx`(`redactedAt`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `release_note` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `version` VARCHAR(191) NOT NULL,
    `previousVersion` VARCHAR(191) NULL,
    `headSha` VARCHAR(191) NULL,
    `compareUrl` VARCHAR(191) NULL,
    `koKR` TEXT NOT NULL,
    `enUS` TEXT NOT NULL,
    `jaJP` TEXT NULL,
    `zhCN` TEXT NULL,
    `zhTW` TEXT NULL,
    `deDE` TEXT NULL,
    `frFR` TEXT NULL,
    `esES` TEXT NULL,
    `sourceJson` JSON NULL,
    `status` ENUM('GENERATED', 'FAILED') NOT NULL DEFAULT 'GENERATED',
    `model` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `release_note_appId_createdAt_idx`(`appId`, `createdAt`),
    UNIQUE INDEX `release_note_repoFullName_version_key`(`repoFullName`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_user` (
    `id` VARCHAR(191) NOT NULL,
    `githubId` BIGINT NOT NULL,
    `login` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `avatarUrl` VARCHAR(191) NULL,
    `role` ENUM('ADMIN', 'MAINTAINER', 'VIEWER') NOT NULL DEFAULT 'VIEWER',
    `allowlisted` BOOLEAN NOT NULL DEFAULT false,
    `lastLoginAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `app_user_githubId_key`(`githubId`),
    UNIQUE INDEX `app_user_login_key`(`login`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_owner` (
    `appId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `role` ENUM('OWNER', 'CONTRIBUTOR') NOT NULL DEFAULT 'OWNER',

    PRIMARY KEY (`appId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_draft` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `stage` ENUM('PLANNING', 'DEVELOPMENT', 'QA', 'MARKET_SUBMISSION', 'RELEASE', 'LIVEOPS') NOT NULL,
    `kind` ENUM('PLANNING_SPEC', 'TASK_BREAKDOWN', 'QA_CHECKLIST', 'STORE_COPY', 'IMPROVEMENT_HYPOTHESIS', 'RELEASE_NOTES', 'BUG_REPORT') NOT NULL,
    `title` TEXT NULL,
    `issueNumber` INTEGER NULL,
    `inputJson` JSON NOT NULL,
    `outputText` TEXT NOT NULL,
    `model` VARCHAR(191) NOT NULL,
    `status` ENUM('DRAFT', 'COMMITTED', 'DISCARDED') NOT NULL DEFAULT 'DRAFT',
    `committedIssueNumber` INTEGER NULL,
    `committedUrl` VARCHAR(191) NULL,
    `committedAt` DATETIME(3) NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ai_draft_appId_stage_status_idx`(`appId`, `stage`, `status`),
    INDEX `ai_draft_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_metric_daily` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `dau` INTEGER NOT NULL DEFAULT 0,
    `newUsers` INTEGER NOT NULL DEFAULT 0,
    `returnRatePct` DOUBLE NULL,
    `d1Pct` DOUBLE NULL,
    `d3Pct` DOUBLE NULL,
    `d7Pct` DOUBLE NULL,
    `engagedUsers` INTEGER NOT NULL DEFAULT 0,
    `avgEngageSec` DOUBLE NULL,
    `adEventUsers` INTEGER NOT NULL DEFAULT 0,
    `adImpressions` INTEGER NOT NULL DEFAULT 0,
    `adCtaUsers` INTEGER NOT NULL DEFAULT 0,
    `adCtaImpressions` INTEGER NOT NULL DEFAULT 0,
    `adCompletedUsers` INTEGER NOT NULL DEFAULT 0,
    `adCompletions` INTEGER NOT NULL DEFAULT 0,
    `networkAdUsers` INTEGER NOT NULL DEFAULT 0,
    `networkAdImpressions` INTEGER NOT NULL DEFAULT 0,
    `dauAndroid` INTEGER NOT NULL DEFAULT 0,
    `dauIos` INTEGER NOT NULL DEFAULT 0,
    `dauWeb` INTEGER NOT NULL DEFAULT 0,
    `raw` JSON NULL,
    `collectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `app_metric_daily_date_idx`(`date`),
    UNIQUE INDEX `app_metric_daily_appId_date_key`(`appId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_content_metric_daily` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `market` VARCHAR(191) NOT NULL DEFAULT 'all',
    `totalEvents` INTEGER NOT NULL DEFAULT 0,
    `raw` JSON NOT NULL,
    `collectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `app_content_metric_daily_date_idx`(`date`),
    UNIQUE INDEX `app_content_metric_daily_appId_date_market_key`(`appId`, `date`, `market`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_console_metric_daily` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `miniAppId` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `dau` INTEGER NULL,
    `newUsers` INTEGER NULL,
    `avgSessionSec` DOUBLE NULL,
    `iaaImpressions` INTEGER NOT NULL DEFAULT 0,
    `iaaEarningKrw` DOUBLE NOT NULL DEFAULT 0,
    `iapTrxAmountKrw` DOUBLE NOT NULL DEFAULT 0,
    `iapSettlementKrw` DOUBLE NOT NULL DEFAULT 0,
    `payingUsers` INTEGER NOT NULL DEFAULT 0,
    `raw` JSON NULL,
    `collectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `app_console_metric_daily_date_idx`(`date`),
    UNIQUE INDEX `app_console_metric_daily_appId_miniAppId_date_key`(`appId`, `miniAppId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `discord_turn` (
    `id` VARCHAR(191) NOT NULL,
    `guildId` VARCHAR(191) NOT NULL,
    `channelId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `teammate` VARCHAR(191) NULL,
    `role` VARCHAR(191) NOT NULL,
    `content` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `discord_turn_guildId_channelId_userId_teammate_createdAt_idx`(`guildId`, `channelId`, `userId`, `teammate`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `teammate_run` (
    `id` VARCHAR(191) NOT NULL,
    `teammate` VARCHAR(191) NOT NULL,
    `trigger` VARCHAR(191) NOT NULL,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `scope` TEXT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `findingCount` INTEGER NOT NULL DEFAULT 0,
    `findings` JSON NULL,
    `issueUrls` JSON NULL,
    `payload` JSON NULL,
    `outcome` TEXT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `teammate_run_dedupeKey_key`(`dedupeKey`),
    INDEX `teammate_run_teammate_createdAt_idx`(`teammate`, `createdAt`),
    INDEX `teammate_run_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_usage` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `model` VARCHAR(191) NOT NULL,
    `path` VARCHAR(191) NOT NULL,
    `teammate` VARCHAR(191) NULL,
    `inputTokens` INTEGER NOT NULL DEFAULT 0,
    `outputTokens` INTEGER NOT NULL DEFAULT 0,
    `thinkingTokens` INTEGER NOT NULL DEFAULT 0,
    `totalTokens` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ai_usage_createdAt_idx`(`createdAt`),
    INDEX `ai_usage_provider_model_createdAt_idx`(`provider`, `model`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_delivery` (
    `deliveryId` VARCHAR(191) NOT NULL,
    `event` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `webhook_delivery_receivedAt_idx`(`receivedAt`),
    PRIMARY KEY (`deliveryId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sync_cursor` (
    `repoFullName` VARCHAR(191) NOT NULL,
    `lastIssueSync` DATETIME(3) NULL,
    `lastPrSync` DATETIME(3) NULL,
    `lastRunSync` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`repoFullName`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_log` (
    `id` VARCHAR(191) NOT NULL,
    `actorLogin` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NULL,
    `payload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_log_entityType_entityId_idx`(`entityType`, `entityId`),
    INDEX `audit_log_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_build_target` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `targetKey` VARCHAR(191) NOT NULL,
    `stack` VARCHAR(191) NOT NULL,
    `market` VARCHAR(191) NULL,
    `packageId` VARCHAR(191) NULL,
    `bundleId` VARCHAR(191) NULL,
    `observedSha` CHAR(40) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `configuration` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `control_plane_build_target_appId_observedSha_idx`(`appId`, `observedSha`),
    UNIQUE INDEX `control_plane_build_target_appId_targetKey_key`(`appId`, `targetKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_external_binding` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `bindingType` VARCHAR(191) NOT NULL,
    `externalId` VARCHAR(191) NOT NULL,
    `publicIdentity` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `control_plane_external_binding_appId_provider_idx`(`appId`, `provider`),
    UNIQUE INDEX `control_plane_external_binding_provider_bindingType_external_key`(`provider`, `bindingType`, `externalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_discovery_observation` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `sourceSha` CHAR(40) NOT NULL,
    `sourceRef` VARCHAR(191) NULL,
    `workflowProfile` VARCHAR(191) NULL,
    `workflowPackageManager` VARCHAR(191) NULL,
    `workflowWorkingDirectory` VARCHAR(191) NULL,
    `payload` JSON NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `requestHash` CHAR(64) NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `observedBy` VARCHAR(191) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `control_plane_discovery_observation_idempotencyKey_key`(`idempotencyKey`),
    INDEX `control_plane_discovery_observation_appId_sourceSha_payloadH_idx`(`appId`, `sourceSha`, `payloadHash`),
    INDEX `control_plane_discovery_observation_appId_observedAt_idx`(`appId`, `observedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_config_revision` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'ACTIVE', 'SUPERSEDED') NOT NULL DEFAULT 'DRAFT',
    `payload` JSON NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `createdBy` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `activeSlot` VARCHAR(191) NULL,
    `activationIdempotencyKey` VARCHAR(191) NULL,
    `activatedSnapshot` JSON NULL,
    `snapshotDigest` CHAR(64) NULL,
    `snapshotSignature` CHAR(64) NULL,
    `activatedAt` DATETIME(3) NULL,
    `supersededAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `control_plane_config_revision_idempotencyKey_key`(`idempotencyKey`),
    UNIQUE INDEX `control_plane_config_revision_activeSlot_key`(`activeSlot`),
    UNIQUE INDEX `control_plane_config_revision_activationIdempotencyKey_key`(`activationIdempotencyKey`),
    INDEX `control_plane_config_revision_appId_status_idx`(`appId`, `status`),
    UNIQUE INDEX `control_plane_config_revision_appId_revision_key`(`appId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_provider_observation` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `resourceType` VARCHAR(191) NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `requestHash` CHAR(64) NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `observedBy` VARCHAR(191) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `control_plane_provider_observation_idempotencyKey_key`(`idempotencyKey`),
    INDEX `control_plane_provider_observation_appId_provider_observedAt_idx`(`appId`, `provider`, `observedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_release_candidate` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `sourceSha` CHAR(40) NOT NULL,
    `configRevisionId` VARCHAR(191) NOT NULL,
    `artifactChecksum` CHAR(64) NOT NULL,
    `status` ENUM('PREPARED', 'READY', 'BLOCKED', 'SUPERSEDED') NOT NULL DEFAULT 'PREPARED',
    `createdBy` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `control_plane_release_candidate_appId_status_createdAt_idx`(`appId`, `status`, `createdAt`),
    UNIQUE INDEX `control_plane_release_candidate_appId_sourceSha_configRevisi_key`(`appId`, `sourceSha`, `configRevisionId`, `artifactChecksum`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_release_gate_observation` (
    `id` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `gate` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'PASSED', 'FAILED', 'HUMAN_REQUIRED') NOT NULL,
    `evidence` JSON NULL,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `observedBy` VARCHAR(191) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `control_plane_release_gate_observation_dedupeKey_key`(`dedupeKey`),
    INDEX `control_plane_release_gate_observation_candidateId_gate_obse_idx`(`candidateId`, `gate`, `observedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_fleet_binding` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `observedVersion` VARCHAR(191) NULL,
    `approvedVersion` VARCHAR(191) NULL,
    `contractRevision` VARCHAR(191) NULL,
    `state` VARCHAR(191) NOT NULL,
    `sourceSha` CHAR(40) NULL,
    `exceptionExpiresAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `platform_fleet_binding_appId_key`(`appId`),
    INDEX `platform_fleet_binding_state_exceptionExpiresAt_idx`(`state`, `exceptionExpiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_credential_binding` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `logicalCredentialId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `capability` VARCHAR(191) NOT NULL,
    `environment` VARCHAR(191) NOT NULL,
    `publicIdentity` VARCHAR(191) NULL,
    `fingerprint` VARCHAR(191) NULL,
    `consumer` VARCHAR(191) NOT NULL,
    `scope` JSON NULL,
    `status` ENUM('ACTIVE', 'SUSPENDED', 'REVOKED', 'NEEDS_REAUTH') NOT NULL DEFAULT 'ACTIVE',
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `control_plane_credential_binding_appId_provider_status_idx`(`appId`, `provider`, `status`),
    UNIQUE INDEX `control_plane_credential_binding_appId_logicalCredentialId_c_key`(`appId`, `logicalCredentialId`, `capability`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `control_plane_reauth_request` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NULL,
    `provider` VARCHAR(191) NOT NULL,
    `origin` VARCHAR(512) NOT NULL,
    `publicAccountId` VARCHAR(191) NOT NULL,
    `capability` VARCHAR(191) NOT NULL,
    `gate` ENUM('CAPTCHA', 'PASSKEY', 'SMS', 'PUSH', 'TRUSTED_DEVICE', 'RECOVERY', 'TERMS', 'ANOMALOUS_LOGIN', 'NEW_LOCATION', 'HUMAN_MFA') NOT NULL,
    `status` ENUM('HUMAN_REAUTH_REQUIRED', 'TRUSTED_LOCAL_PENDING') NOT NULL DEFAULT 'HUMAN_REAUTH_REQUIRED',
    `generation` INTEGER NOT NULL DEFAULT 0,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `trustedLocalIdempotencyKey` VARCHAR(191) NULL,
    `requestedBy` VARCHAR(191) NOT NULL,
    `trustedLocalRequestedBy` VARCHAR(191) NULL,
    `trustedLocalRequestedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `control_plane_reauth_request_idempotencyKey_key`(`idempotencyKey`),
    UNIQUE INDEX `control_plane_reauth_request_trustedLocalIdempotencyKey_key`(`trustedLocalIdempotencyKey`),
    INDEX `control_plane_reauth_request_appId_status_createdAt_idx`(`appId`, `status`, `createdAt`),
    INDEX `control_plane_reauth_request_runId_status_idx`(`runId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `repository_registration` (
    `repoId` BIGINT NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `defaultBranch` VARCHAR(191) NULL,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('REGISTERED', 'NEEDS_INPUT', 'MANAGED', 'ARCHIVED') NOT NULL DEFAULT 'REGISTERED',
    `discoveryCandidates` JSON NULL,
    `lastDefaultPushSha` CHAR(40) NULL,
    `lastDeliveryId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `repository_registration_repoFullName_key`(`repoFullName`),
    INDEX `repository_registration_status_updatedAt_idx`(`status`, `updatedAt`),
    PRIMARY KEY (`repoId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_definition` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `template` VARCHAR(191) NOT NULL,
    `schedule` VARCHAR(191) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `maxAttempts` INTEGER NOT NULL DEFAULT 3,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `automation_definition_key_key`(`key`),
    INDEX `automation_definition_enabled_idx`(`enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_occurrence` (
    `id` VARCHAR(191) NOT NULL,
    `definitionId` VARCHAR(191) NOT NULL,
    `scheduledFor` DATETIME(3) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD_LETTER') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    UNIQUE INDEX `automation_occurrence_idempotencyKey_key`(`idempotencyKey`),
    INDEX `automation_occurrence_status_scheduledFor_idx`(`status`, `scheduledFor`),
    UNIQUE INDEX `automation_occurrence_definitionId_scheduledFor_key`(`definitionId`, `scheduledFor`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_run` (
    `id` VARCHAR(191) NOT NULL,
    `occurrenceId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NULL,
    `issueState` VARCHAR(191) NULL,
    `labels` JSON NOT NULL,
    `createsPr` BOOLEAN NOT NULL DEFAULT true,
    `priority` INTEGER NOT NULL DEFAULT 100,
    `status` ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `leaseGeneration` INTEGER NOT NULL DEFAULT 0,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER NOT NULL DEFAULT 3,
    `eligibleAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `outcome` JSON NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `agent_run_status_eligibleAt_priority_idx`(`status`, `eligibleAt`, `priority`),
    INDEX `agent_run_repoFullName_status_idx`(`repoFullName`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_lease` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `generation` INTEGER NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `workerId` VARCHAR(191) NOT NULL,
    `scopeKey` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `heartbeatAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `agent_lease_scopeKey_key`(`scopeKey`),
    INDEX `agent_lease_workerId_expiresAt_idx`(`workerId`, `expiresAt`),
    UNIQUE INDEX `agent_lease_runId_generation_key`(`runId`, `generation`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_run_event` (
    `id` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NULL,
    `runId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `generation` INTEGER NULL,
    `actor` VARCHAR(191) NOT NULL,
    `payload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `agent_run_event_requestId_key`(`requestId`),
    INDEX `agent_run_event_runId_createdAt_idx`(`runId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `vault_chunk` (
    `id` VARCHAR(191) NOT NULL,
    `path` VARCHAR(191) NOT NULL,
    `ord` INTEGER NOT NULL,
    `heading` TEXT NULL,
    `text` TEXT NOT NULL,
    `fileHash` VARCHAR(191) NOT NULL,
    `embedding` LONGBLOB NOT NULL,
    `dim` INTEGER NOT NULL,
    `chars` INTEGER NOT NULL DEFAULT 0,
    `indexedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `vault_chunk_fileHash_idx`(`fileHash`),
    INDEX `vault_chunk_indexedAt_idx`(`indexedAt`),
    UNIQUE INDEX `vault_chunk_path_ord_key`(`path`, `ord`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `vault_write_request` (
    `id` VARCHAR(191) NOT NULL,
    `folder` VARCHAR(191) NOT NULL DEFAULT '받은함',
    `filename` VARCHAR(191) NOT NULL,
    `content` TEXT NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'agent',
    `requestedBy` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'DONE', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `writtenPath` VARCHAR(191) NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,

    INDEX `vault_write_request_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_user_metric_sample` (
    `id` VARCHAR(191) NOT NULL,
    `capturedAt` DATETIME(3) NOT NULL,
    `totalUsers` INTEGER NOT NULL DEFAULT 0,
    `hourlyActiveUsers` INTEGER NOT NULL DEFAULT 0,
    `dailyActiveUsers` INTEGER NOT NULL DEFAULT 0,
    `weeklyActiveUsers` INTEGER NOT NULL DEFAULT 0,
    `activitySource` VARCHAR(191) NOT NULL DEFAULT 'session_last_seen',
    `collectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `platform_user_metric_sample_capturedAt_key`(`capturedAt`),
    INDEX `platform_user_metric_sample_capturedAt_idx`(`capturedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
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

-- AddForeignKey
ALTER TABLE `stage_transition` ADD CONSTRAINT `stage_transition_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `issue_mirror` ADD CONSTRAINT `issue_mirror_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pull_request_mirror` ADD CONSTRAINT `pull_request_mirror_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workflow_run_mirror` ADD CONSTRAINT `workflow_run_mirror_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `release_record` ADD CONSTRAINT `release_record_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification_delivery` ADD CONSTRAINT `notification_delivery_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `notification_event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `operator_command_run` ADD CONSTRAINT `operator_command_run_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `operational_incident` ADD CONSTRAINT `operational_incident_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `operational_milestone` ADD CONSTRAINT `operational_milestone_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `store_review_sync` ADD CONSTRAINT `store_review_sync_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `store_review_observation` ADD CONSTRAINT `store_review_observation_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_operation_run` ADD CONSTRAINT `app_operation_run_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `release_note` ADD CONSTRAINT `release_note_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_owner` ADD CONSTRAINT `app_owner_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_owner` ADD CONSTRAINT `app_owner_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `app_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_draft` ADD CONSTRAINT `ai_draft_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_metric_daily` ADD CONSTRAINT `app_metric_daily_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_content_metric_daily` ADD CONSTRAINT `app_content_metric_daily_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_console_metric_daily` ADD CONSTRAINT `app_console_metric_daily_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_build_target` ADD CONSTRAINT `control_plane_build_target_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_external_binding` ADD CONSTRAINT `control_plane_external_binding_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_discovery_observation` ADD CONSTRAINT `control_plane_discovery_observation_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_config_revision` ADD CONSTRAINT `control_plane_config_revision_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_provider_observation` ADD CONSTRAINT `control_plane_provider_observation_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_release_candidate` ADD CONSTRAINT `control_plane_release_candidate_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_release_candidate` ADD CONSTRAINT `control_plane_release_candidate_configRevisionId_fkey` FOREIGN KEY (`configRevisionId`) REFERENCES `control_plane_config_revision`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_release_gate_observation` ADD CONSTRAINT `control_plane_release_gate_observation_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `control_plane_release_candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `platform_fleet_binding` ADD CONSTRAINT `platform_fleet_binding_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_credential_binding` ADD CONSTRAINT `control_plane_credential_binding_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_reauth_request` ADD CONSTRAINT `control_plane_reauth_request_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `control_plane_reauth_request` ADD CONSTRAINT `control_plane_reauth_request_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `agent_run`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `automation_definition` ADD CONSTRAINT `automation_definition_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `automation_occurrence` ADD CONSTRAINT `automation_occurrence_definitionId_fkey` FOREIGN KEY (`definitionId`) REFERENCES `automation_definition`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_run` ADD CONSTRAINT `agent_run_occurrenceId_fkey` FOREIGN KEY (`occurrenceId`) REFERENCES `automation_occurrence`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_run` ADD CONSTRAINT `agent_run_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `app`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_lease` ADD CONSTRAINT `agent_lease_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `agent_run`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_run_event` ADD CONSTRAINT `agent_run_event_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `agent_run`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
