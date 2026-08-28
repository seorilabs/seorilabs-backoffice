import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

if (process.env.MIGRATION_FIXTURE_ACK !== "LOCAL_SCHEMA_ONLY") {
  throw new Error("MIGRATION_FIXTURE_ACK=LOCAL_SCHEMA_ONLY가 필요하다");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("lineage loss fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("lineage loss fixture DB 이름은 _contract_test로 끝나야 한다");
}

const legacyLedgerLines = readFileSync(
  "prisma/migration-archive/production-ledger-v1.tsv",
  "utf8",
).trimEnd().split("\n").slice(1);
const legacyNames = new Set(legacyLedgerLines.map((line) => line.split("\t")[0]));

type MigrationRow = {
  id: string;
  checksum: string;
  finishedAt: Date | null;
  migrationName: string;
  logs: string | null;
  rolledBackAt: Date | null;
  startedAt: Date;
  appliedStepsCount: number | bigint;
};

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const allRows = await prisma.$queryRawUnsafe<MigrationRow[]>(`
      SELECT
        id,
        checksum,
        finished_at AS finishedAt,
        migration_name AS migrationName,
        logs,
        rolled_back_at AS rolledBackAt,
        started_at AS startedAt,
        applied_steps_count AS appliedStepsCount
      FROM _prisma_migrations
      ORDER BY started_at, id
    `);
    const legacyRows = allRows.filter((row) => legacyNames.has(row.migrationName));
    if (legacyRows.length !== legacyLedgerLines.length) {
      throw new Error("lineage loss fixture의 legacy audit 원본이 완전하지 않다");
    }
    try {
      for (const name of legacyNames) {
        await prisma.$executeRawUnsafe(
          "DELETE FROM _prisma_migrations WHERE migration_name = ?",
          name,
        );
      }
      const result = spawnSync(
        "pnpm",
        [
          "tsx",
          "scripts/verify-migration-state.ts",
          "--history=predeploy",
          "--expected-lineage=cutover",
        ],
        { cwd: process.cwd(), env: process.env, encoding: "utf8" },
      );
      const output = `${result.stdout}${result.stderr}`;
      if (result.status === 0 || !output.includes("migration lineage 불일치")) {
        throw new Error("legacy audit 전량 삭제를 expected cutover gate가 거부하지 않았다");
      }
    } finally {
      for (const row of legacyRows) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO _prisma_migrations
            (id, checksum, finished_at, migration_name, logs, rolled_back_at,
             started_at, applied_steps_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             checksum = VALUES(checksum),
             finished_at = VALUES(finished_at),
             migration_name = VALUES(migration_name),
             logs = VALUES(logs),
             rolled_back_at = VALUES(rolled_back_at),
             started_at = VALUES(started_at),
             applied_steps_count = VALUES(applied_steps_count)`,
          row.id,
          row.checksum,
          row.finishedAt,
          row.migrationName,
          row.logs,
          row.rolledBackAt,
          row.startedAt,
          row.appliedStepsCount,
        );
      }
    }
    const restored = spawnSync(
      "pnpm",
      ["tsx", "scripts/verify-migration-state.ts", "--history=cutover"],
      { cwd: process.cwd(), env: process.env, encoding: "utf8" },
    );
    if (restored.status !== 0) {
      throw new Error("lineage loss fixture가 legacy audit 원본을 복원하지 못했다");
    }
    console.log("cutover lineage loss classifier 계약 통과");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    "migration lineage loss fixture 실패:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exit(1);
});
