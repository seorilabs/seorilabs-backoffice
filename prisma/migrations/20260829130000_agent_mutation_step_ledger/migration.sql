-- READY_PR provider mutation을 commit, ref, PR 세 단계의 durable ledger로 분리한다.
CREATE TABLE `agent_mutation_step` (
    `id` VARCHAR(191) NOT NULL,
    `executionId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `ordinal` INTEGER NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    `generation` INTEGER NOT NULL DEFAULT 0,
    `inputDigest` CHAR(64) NULL,
    `expectedTreeSha` CHAR(40) NULL,
    `expectedCommitSha` CHAR(40) NULL,
    `outputSha` CHAR(40) NULL,
    `outputNumber` INTEGER NULL,
    `outputNodeId` VARCHAR(191) NULL,
    `outputUrl` VARCHAR(2048) NULL,
    `lastReadbackDigest` CHAR(64) NULL,
    `claimExpiresAt` DATETIME(3) NULL,
    `verifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `agent_mutation_step_execution_kind_key`(`executionId`, `kind`),
    UNIQUE INDEX `agent_mutation_step_execution_ordinal_key`(`executionId`, `ordinal`),
    INDEX `agent_mutation_step_status_expiry_idx`(`status`, `claimExpiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `agent_mutation_step_attempt` (
    `id` VARCHAR(191) NOT NULL,
    `stepId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(64) NOT NULL,
    `generation` INTEGER NOT NULL,
    `principalId` VARCHAR(128) NOT NULL,
    `runtimeBindingDigest` CHAR(64) NOT NULL,
    `adapterPrincipalId` VARCHAR(128) NOT NULL,
    `adapterRuntimeIdentity` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `bindingDigest` CHAR(64) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'CLAIMED',
    `expiresAt` DATETIME(3) NOT NULL,
    `planRequestId` VARCHAR(191) NULL,
    `planDigest` CHAR(64) NULL,
    `completionRequestId` VARCHAR(191) NULL,
    `completionDigest` CHAR(64) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `agent_mutation_step_attempt_request_id_key`(`requestId`),
    UNIQUE INDEX `agent_mutation_step_attempt_plan_request_id_key`(`planRequestId`),
    UNIQUE INDEX `agent_mutation_step_attempt_completion_request_id_key`(`completionRequestId`),
    UNIQUE INDEX `agent_mutation_step_attempt_generation_key`(`stepId`, `generation`),
    INDEX `agent_mutation_step_attempt_session_expiry_idx`(`sessionId`, `expiresAt`),
    INDEX `agent_mutation_step_attempt_status_expiry_idx`(`status`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `agent_mutation_step`
    ADD CONSTRAINT `agent_mutation_step_execution_id_fkey`
    FOREIGN KEY (`executionId`) REFERENCES `agent_mutation_execution`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE `agent_mutation_step_attempt`
    ADD CONSTRAINT `agent_mutation_step_attempt_step_id_fkey`
    FOREIGN KEY (`stepId`) REFERENCES `agent_mutation_step`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE `agent_mutation_step_attempt`
    ADD CONSTRAINT `agent_mutation_step_attempt_session_id_fkey`
    FOREIGN KEY (`sessionId`) REFERENCES `agent_worker_session`(`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
