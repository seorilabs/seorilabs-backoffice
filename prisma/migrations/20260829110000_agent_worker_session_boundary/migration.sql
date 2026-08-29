-- CreateTable
CREATE TABLE `agent_worker_session` (
    `id` VARCHAR(64) NOT NULL,
    `leaseId` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `generation` INTEGER NOT NULL,
    `principalId` VARCHAR(128) NOT NULL,
    `runtimeBindingDigest` CHAR(64) NOT NULL,
    `repoId` BIGINT NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NULL,
    `sourceSha` CHAR(40) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `heartbeatAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `settledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `agent_worker_session_leaseId_key`(`leaseId`),
    UNIQUE INDEX `agent_worker_session_run_generation_key`(`runId`, `generation`),
    INDEX `agent_worker_session_principal_expiry_idx`(`principalId`, `expiresAt`),
    INDEX `agent_worker_session_runtime_expiry_idx`(`runtimeBindingDigest`, `expiresAt`),
    INDEX `agent_worker_session_repo_source_idx`(`repoId`, `sourceSha`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_github_observation` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(64) NOT NULL,
    `phase` VARCHAR(16) NOT NULL,
    `adapterPrincipalId` VARCHAR(128) NOT NULL,
    `adapterRuntimeIdentity` VARCHAR(191) NOT NULL,
    `githubInstallationId` VARCHAR(30) NOT NULL,
    `providerSnapshotId` VARCHAR(191) NOT NULL,
    `pageCount` INTEGER NOT NULL,
    `repoId` BIGINT NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `defaultBranchRef` VARCHAR(255) NOT NULL,
    `defaultBranchSha` CHAR(40) NOT NULL,
    `issueNumber` INTEGER NULL,
    `issueNodeId` VARCHAR(191) NULL,
    `issueState` VARCHAR(16) NULL,
    `issueLabels` JSON NULL,
    `issueUpdatedAt` DATETIME(3) NULL,
    `openAutopilotPullRequests` JSON NOT NULL,
    `mutationTarget` JSON NULL,
    `payloadDigest` CHAR(64) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `agent_github_observation_session_phase_idx`(`sessionId`, `phase`, `observedAt`),
    INDEX `agent_github_observation_repo_observed_idx`(`repoId`, `observedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_adapter_nonce` (
    `nonceDigest` CHAR(64) NOT NULL,
    `route` VARCHAR(191) NOT NULL,
    `bodyDigest` CHAR(64) NOT NULL,
    `runtimeIdentity` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `agent_adapter_nonce_expires_idx`(`expiresAt`),
    PRIMARY KEY (`nonceDigest`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_action_grant` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(64) NOT NULL,
    `observationId` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `generation` INTEGER NOT NULL,
    `principalId` VARCHAR(128) NOT NULL,
    `adapterPrincipalId` VARCHAR(128) NOT NULL,
    `adapterRuntimeIdentity` VARCHAR(191) NOT NULL,
    `repoId` BIGINT NOT NULL,
    `repoFullName` VARCHAR(191) NOT NULL,
    `issueNumber` INTEGER NULL,
    `sourceSha` CHAR(40) NOT NULL,
    `action` VARCHAR(64) NOT NULL,
    `mutationIntentDigest` CHAR(64) NOT NULL,
    `expectedHeadRef` VARCHAR(255) NOT NULL,
    `expectedPullRequestMarker` VARCHAR(191) NOT NULL,
    `bindingDigest` CHAR(64) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `agent_action_grant_observation_id_key`(`observationId`),
    UNIQUE INDEX `agent_action_grant_request_id_key`(`requestId`),
    UNIQUE INDEX `agent_action_grant_run_generation_action_key`(`runId`, `generation`, `action`),
    INDEX `agent_action_grant_repo_expiry_idx`(`repoFullName`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_mutation_execution` (
    `id` VARCHAR(191) NOT NULL,
    `grantId` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(64) NOT NULL,
    `generation` INTEGER NOT NULL,
    `action` VARCHAR(64) NOT NULL,
    `adapterPrincipalId` VARCHAR(128) NOT NULL,
    `adapterRuntimeIdentity` VARCHAR(191) NOT NULL,
    `bindingDigest` CHAR(64) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `readbackObservationId` VARCHAR(191) NULL,
    `pullRequestNumber` INTEGER NULL,
    `pullRequestNodeId` VARCHAR(191) NULL,
    `pullRequestUrl` VARCHAR(2048) NULL,
    `pullRequestHeadRef` VARCHAR(255) NULL,
    `pullRequestHeadSha` CHAR(40) NULL,
    `pullRequestBaseSha` CHAR(40) NULL,
    `pullRequestMarker` VARCHAR(191) NULL,
    `closesClaimedIssue` BOOLEAN NULL,
    `resultDigest` CHAR(64) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `verifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `agent_mutation_execution_grant_id_key`(`grantId`),
    INDEX `agent_mutation_execution_run_gen_status_idx`(`runId`, `generation`, `status`),
    INDEX `agent_mutation_execution_session_status_idx`(`sessionId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_mutation_readback` (
    `id` VARCHAR(191) NOT NULL,
    `executionId` VARCHAR(191) NOT NULL,
    `observationId` VARCHAR(191) NOT NULL,
    `adapterPrincipalId` VARCHAR(128) NOT NULL,
    `adapterRuntimeIdentity` VARCHAR(191) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `resultDigest` CHAR(64) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `agent_mutation_readback_observation_id_key`(`observationId`),
    UNIQUE INDEX `agent_mutation_readback_request_id_key`(`requestId`),
    INDEX `agent_mutation_readback_execution_created_idx`(`executionId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `agent_worker_session` ADD CONSTRAINT `agent_worker_session_lease_id_fkey` FOREIGN KEY (`leaseId`) REFERENCES `agent_lease`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `agent_github_observation` ADD CONSTRAINT `agent_github_observation_session_id_fkey` FOREIGN KEY (`sessionId`) REFERENCES `agent_worker_session`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `agent_action_grant` ADD CONSTRAINT `agent_action_grant_session_id_fkey` FOREIGN KEY (`sessionId`) REFERENCES `agent_worker_session`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `agent_action_grant` ADD CONSTRAINT `agent_action_grant_observation_id_fkey` FOREIGN KEY (`observationId`) REFERENCES `agent_github_observation`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `agent_mutation_execution` ADD CONSTRAINT `agent_mutation_execution_grant_id_fkey` FOREIGN KEY (`grantId`) REFERENCES `agent_action_grant`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `agent_mutation_readback` ADD CONSTRAINT `agent_mutation_readback_execution_id_fkey` FOREIGN KEY (`executionId`) REFERENCES `agent_mutation_execution`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `agent_mutation_readback` ADD CONSTRAINT `agent_mutation_readback_observation_id_fkey` FOREIGN KEY (`observationId`) REFERENCES `agent_github_observation`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
