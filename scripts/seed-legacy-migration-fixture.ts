import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

type FixtureRow = {
  name: string;
  checksum: string;
  status: "SUCCEEDED" | "ROLLED_BACK";
  steps: number;
};

if (process.env.MIGRATION_FIXTURE_ACK !== "LOCAL_SCHEMA_ONLY") {
  throw new Error("MIGRATION_FIXTURE_ACK=LOCAL_SCHEMA_ONLY가 필요하다");
}

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("legacy fixture는 loopback MySQL에서만 허용한다");
}
const databaseName = databaseUrl.pathname.slice(1);
if (!databaseName.endsWith("_contract_test")) {
  throw new Error("legacy fixture DB 이름은 _contract_test로 끝나야 한다");
}

const ledgerPath = resolve(
  process.cwd(),
  "prisma/migration-archive/production-ledger-v1.tsv",
);
const lines = readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
if (
  lines.shift() !==
  "migration_name\tchecksum\tstatus\tapplied_steps_count\toccurrence"
) {
  throw new Error("legacy fixture ledger header가 올바르지 않다");
}
const rows: FixtureRow[] = lines.map((line) => {
  const [name, checksum, status, steps] = line.split("\t");
  if (status !== "SUCCEEDED" && status !== "ROLLED_BACK") {
    throw new Error(`legacy fixture status가 올바르지 않다: ${name}`);
  }
  return { name, checksum, status, steps: Number(steps) };
});

function fixtureId(index: number, name: string): string {
  const value = createHash("sha256")
    .update(`${index}:${name}`)
    .digest("hex")
    .slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const [history] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`
    SELECT COUNT(*) AS count
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_prisma_migrations'
  `);
    if (Number(history.count) !== 0) {
      throw new Error("legacy fixture DB에 migration history가 이미 있다");
    }

    await prisma.$executeRawUnsafe(`
    CREATE TABLE \`_prisma_migrations\` (
      \`id\` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
      \`checksum\` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
      \`finished_at\` datetime(3) DEFAULT NULL,
      \`migration_name\` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
      \`logs\` text COLLATE utf8mb4_unicode_ci,
      \`rolled_back_at\` datetime(3) DEFAULT NULL,
      \`started_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      \`applied_steps_count\` int unsigned NOT NULL DEFAULT '0',
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

    for (const [index, row] of rows.entries()) {
      const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
      const terminalAt = new Date(startedAt.getTime() + 500);
      await prisma.$executeRawUnsafe(
        `INSERT INTO _prisma_migrations
        (id, checksum, finished_at, migration_name, logs, rolled_back_at,
         started_at, applied_steps_count)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
        fixtureId(index, row.name),
        row.checksum,
        row.status === "SUCCEEDED" ? terminalAt : null,
        row.name,
        row.status === "ROLLED_BACK" ? terminalAt : null,
        startedAt,
        row.steps,
      );
    }
    console.log(`legacy migration fixture 생성: rows=${rows.length}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    "legacy migration fixture 생성 실패:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exit(1);
});
