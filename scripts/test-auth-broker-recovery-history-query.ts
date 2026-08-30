import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

if (process.env.MIGRATION_FIXTURE_ACK !== "LOCAL_SCHEMA_ONLY") {
  throw new Error("MIGRATION_FIXTURE_ACK=LOCAL_SCHEMA_ONLY가 필요하다");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("recovery query fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("recovery query fixture DB 이름은 _contract_test로 끝나야 한다");
}

const migration = "20260830050000_auth_broker_journal_checkpoint";
type MigrationRow = {
  id: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
  applied_steps_count: bigint;
};

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let original: MigrationRow | undefined;
  try {
    const rows = await prisma.$queryRawUnsafe<MigrationRow[]>(
      `SELECT id, finished_at, rolled_back_at, applied_steps_count
       FROM _prisma_migrations WHERE migration_name = ?`,
      migration,
    );
    if (
      rows.length !== 1 || rows[0].finished_at === null ||
      rows[0].rolled_back_at !== null || rows[0].applied_steps_count !== 1n
    ) {
      throw new Error("recovery query fixture의 원본 migration 상태가 정확하지 않다");
    }
    [original] = rows;
    await prisma.$executeRawUnsafe(
      `UPDATE _prisma_migrations
       SET finished_at = NULL, rolled_back_at = NULL, applied_steps_count = 0
       WHERE id = ?`,
      original.id,
    );

    const manifest = readFileSync(
      join(process.cwd(), "k8s/auth-broker-journal-trigger-recovery-job.yaml"),
      "utf8",
    );
    const match = manifest.match(
      /history_state="\$\(q "(SELECT CONCAT\([\s\S]*?WHERE migration_name='20260830050000_auth_broker_journal_checkpoint')"\)"/,
    );
    if (!match) {
      throw new Error("auth broker journal recovery history query를 찾지 못했다");
    }
    const query = match[1].replace(
      "FROM backoffice._prisma_migrations",
      "FROM _prisma_migrations",
    );
    if (query === match[1]) {
      throw new Error("recovery query의 production schema binding이 정확하지 않다");
    }
    const queryRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(query);
    if (Object.values(queryRows[0] ?? {})[0] !== "1:1:1:0:0:1") {
      throw new Error("auth broker journal recovery history query 결과가 정확하지 않다");
    }
    console.log("auth broker journal recovery history query 계약 통과");
  } finally {
    if (original) {
      await prisma.$executeRawUnsafe(
        `UPDATE _prisma_migrations
         SET finished_at = ?, rolled_back_at = ?, applied_steps_count = ?
         WHERE id = ?`,
        original.finished_at,
        original.rolled_back_at,
        original.applied_steps_count,
        original.id,
      );
    }
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error("auth broker journal recovery history query fixture 실패");
  process.exit(1);
});
