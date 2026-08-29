-- contract 단계: 폐기된 AI 팀원 체계의 스키마를 제거한다.
--
-- 2026-08-29(PR #165)에 읽고 쓰는 코드를 모두 걷어냈고, 그 배포가 production 에
-- 반영된 뒤 이 migration 이 남은 컬럼·테이블을 지운다. expand → contract 두 단계로
-- 나눈 이유는 롤링 배포 중 구 Pod 가 이 컬럼들을 참조하지 않게 하기 위해서다.
--
-- 이 migration 은 expand-only 계약의 예외다. prisma/migration-history.json 의
-- approvedContractMigrations 에 이름·checksum·사유가 함께 등록돼야 게이트를 통과한다.

-- 담당 배분. 단일 컬럼 인덱스는 컬럼과 함께 사라진다.
ALTER TABLE `app` DROP COLUMN `ownerTeammate`;

-- 순찰·멘션 큐. 팀원 체계와 함께 통째로 폐기됐다.
DROP TABLE `teammate_run`;

-- 팀원 봇 대화 격리 축. 복합 인덱스에 들어 있어 인덱스를 먼저 정리한 뒤 컬럼을 지운다.
-- 컬럼만 지우면 MySQL 이 인덱스에서 컬럼만 빼고 옛 이름을 남겨 Prisma 계약과 어긋난다.
DROP INDEX `discord_turn_guildId_channelId_userId_teammate_createdAt_idx` ON `discord_turn`;
ALTER TABLE `discord_turn` DROP COLUMN `teammate`;
CREATE INDEX `discord_turn_guildId_channelId_userId_createdAt_idx`
    ON `discord_turn`(`guildId`, `channelId`, `userId`, `createdAt`);

-- LLM 사용량의 팀원 귀속 축. 비용 집계는 provider·model 로만 한다.
ALTER TABLE `ai_usage` DROP COLUMN `teammate`;
