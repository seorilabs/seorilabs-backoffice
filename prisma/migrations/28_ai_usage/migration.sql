-- LLM 호출 사용량 원장. provider 호출 직후 fire-and-forget 적재,
-- 서리 재무 순찰이 pricing.ts 단가표로 월누적 비용을 집계한다.
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
