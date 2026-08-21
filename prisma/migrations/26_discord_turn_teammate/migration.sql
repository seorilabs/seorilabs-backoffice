-- AI 팀원 봇의 대화 문맥을 메인 봇 /ask 와 격리한다.
-- 기존 행은 teammate NULL 로 남아 메인 봇 히스토리로 계속 동작한다.
ALTER TABLE `discord_turn`
    ADD COLUMN `teammate` VARCHAR(191) NULL AFTER `userId`;

DROP INDEX `discord_turn_guildId_channelId_userId_createdAt_idx` ON `discord_turn`;

CREATE INDEX `discord_turn_guildId_channelId_userId_teammate_createdAt_idx`
    ON `discord_turn`(`guildId`, `channelId`, `userId`, `teammate`, `createdAt`);
