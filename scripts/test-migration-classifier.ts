import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

if (process.env.MIGRATION_FIXTURE_ACK !== "LOCAL_SCHEMA_ONLY") {
  throw new Error("MIGRATION_FIXTURE_ACK=LOCAL_SCHEMA_ONLY가 필요하다");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("classifier fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("classifier fixture DB 이름은 _contract_test로 끝나야 한다");
}

const first = "99999999999998_first_expand";
const second = "99999999999999_second_expand";
const fixtureId = "00000000-0000-4000-8000-000000000161";
const recoveryFixtureId = "00000000-0000-4000-8000-000000000162";
const extraRecoveryFixtureId = "00000000-0000-4000-8000-000000000163";
const recoveredMigration = "20260828230000_provider_execution_queue";
const pendingRecoveryMigration = "20260830050000_auth_broker_journal_checkpoint";

async function main(): Promise<void> {
  const root = process.cwd();
  const migrationRoot = mkdtempSync(join(tmpdir(), "migration-prefix-contract-"));
  const activeRoot = join(root, "prisma/migrations");
  for (const name of readdirSync(activeRoot).sort()) {
    if (!statSync(join(activeRoot, name)).isDirectory()) continue;
    mkdirSync(join(migrationRoot, name));
    copyFileSync(
      join(activeRoot, name, "migration.sql"),
      join(migrationRoot, name, "migration.sql"),
    );
  }
  copyFileSync(
    join(root, "prisma/migrations/migration_lock.toml"),
    join(migrationRoot, "migration_lock.toml"),
  );
  for (const name of [first, second]) {
    mkdirSync(join(migrationRoot, name));
    writeFileSync(
      join(migrationRoot, name, "migration.sql"),
      `CREATE TABLE \`${name}\` (\`id\` VARCHAR(32) NOT NULL);\n`,
    );
  }
  const secondSql = readFileSync(join(migrationRoot, second, "migration.sql"));
  const secondChecksum = createHash("sha256").update(secondSql).digest("hex");
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE _prisma_migrations
       SET finished_at = NULL, rolled_back_at = NULL, applied_steps_count = 1
       WHERE migration_name = ?`,
      pendingRecoveryMigration,
    );
    const nonzeroPendingRecovery = spawnSync(
      "pnpm",
      [
        "tsx",
        "scripts/verify-migration-state.ts",
        "--history=predeploy",
        `--recovery-state=${pendingRecoveryMigration}`,
      ],
      { cwd: root, env: process.env, encoding: "utf8" },
    );
    const nonzeroPendingOutput =
      `${nonzeroPendingRecovery.stdout}${nonzeroPendingRecovery.stderr}`;
    if (
      nonzeroPendingRecovery.status === 0
      || !nonzeroPendingOutput.includes("applied step이 0이 아니다")
    ) {
      throw new Error("nonzero applied step의 unresolved recovery를 거부하지 않았다");
    }
    await prisma.$executeRawUnsafe(
      `UPDATE _prisma_migrations
       SET applied_steps_count = 0
       WHERE migration_name = ?`,
      pendingRecoveryMigration,
    );
    const recoveryManifest = readFileSync(
      join(root, "k8s/auth-broker-journal-trigger-recovery-job.yaml"),
      "utf8",
    );
    const recoveryQueryMatch = recoveryManifest.match(
      /history_state="\$\(q "(SELECT CONCAT\([\s\S]*?WHERE migration_name='20260830050000_auth_broker_journal_checkpoint')"\)"/,
    );
    if (!recoveryQueryMatch) {
      throw new Error("auth broker journal recovery history query를 찾지 못했다");
    }
    const recoveryQuery = recoveryQueryMatch[1].replace(
      "FROM backoffice._prisma_migrations",
      "FROM _prisma_migrations",
    );
    const recoveryRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      recoveryQuery,
    );
    if (Object.values(recoveryRows[0] ?? {})[0] !== "1:1:1:0:0:1") {
      throw new Error("auth broker journal recovery history query 결과가 정확하지 않다");
    }
    const exactPendingRecovery = spawnSync(
      "pnpm",
      [
        "tsx",
        "scripts/verify-migration-state.ts",
        "--history=predeploy",
        `--recovery-state=${pendingRecoveryMigration}`,
      ],
      { cwd: root, env: process.env, encoding: "utf8" },
    );
    if (
      exactPendingRecovery.status !== 0
      || exactPendingRecovery.stdout.trim() !== "UNRESOLVED_EXACT"
    ) {
      throw new Error("zero applied step의 단일 unresolved recovery를 인식하지 못했다");
    }
    await prisma.$executeRawUnsafe(
      `UPDATE _prisma_migrations
       SET finished_at = CURRENT_TIMESTAMP(3), rolled_back_at = NULL, applied_steps_count = 1
       WHERE migration_name = ?`,
      pendingRecoveryMigration,
    );

    const recoveredSql = readFileSync(
      join(activeRoot, recoveredMigration, "migration.sql"),
    );
    const recoveredChecksum = createHash("sha256").update(recoveredSql).digest("hex");
    await prisma.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations
        (id, checksum, finished_at, migration_name, logs, rolled_back_at,
         started_at, applied_steps_count)
       VALUES (?, ?, NULL, ?, NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), 0)`,
      recoveryFixtureId,
      recoveredChecksum,
      recoveredMigration,
    );
    const allowedRecovery = spawnSync(
      "pnpm",
      ["tsx", "scripts/verify-migration-state.ts", "--history=predeploy"],
      { cwd: root, env: process.env, encoding: "utf8" },
    );
    if (allowedRecovery.status !== 0) {
      throw new Error("manifest에 고정한 단일 active rollback을 허용하지 않았다");
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations
        (id, checksum, finished_at, migration_name, logs, rolled_back_at,
         started_at, applied_steps_count)
       VALUES (?, ?, NULL, ?, NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), 0)`,
      extraRecoveryFixtureId,
      recoveredChecksum,
      recoveredMigration,
    );
    const excessiveRecovery = spawnSync(
      "pnpm",
      ["tsx", "scripts/verify-migration-state.ts", "--history=predeploy"],
      { cwd: root, env: process.env, encoding: "utf8" },
    );
    const excessiveOutput = `${excessiveRecovery.stdout}${excessiveRecovery.stderr}`;
    if (
      excessiveRecovery.status === 0 ||
      !excessiveOutput.includes("허용되지 않은 active rollback attempt")
    ) {
      throw new Error("두 번째 active rollback attempt를 거부하지 않았다");
    }
    await prisma.$executeRawUnsafe(
      "DELETE FROM _prisma_migrations WHERE id = ?",
      extraRecoveryFixtureId,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations
        (id, checksum, finished_at, migration_name, logs, rolled_back_at,
         started_at, applied_steps_count)
       VALUES (?, ?, CURRENT_TIMESTAMP(3), ?, NULL, NULL, CURRENT_TIMESTAMP(3), 1)`,
      fixtureId,
      secondChecksum,
      second,
    );
    const result = spawnSync(
      "pnpm",
      ["tsx", "scripts/verify-migration-state.ts", "--history=predeploy"],
      {
        cwd: root,
        env: { ...process.env, MIGRATION_ROOT: migrationRoot },
        encoding: "utf8",
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    if (result.status === 0 || !output.includes("사전식 prefix가 아니다")) {
      throw new Error("active migration gap을 predeploy가 거부하지 않았다");
    }
    console.log("active migration prefix classifier 계약 통과");
  } finally {
    await prisma.$executeRawUnsafe(
      `UPDATE _prisma_migrations
       SET finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP(3)),
           rolled_back_at = NULL,
           applied_steps_count = 1
       WHERE migration_name = ?`,
      pendingRecoveryMigration,
    );
    await prisma.$executeRawUnsafe(
      "DELETE FROM _prisma_migrations WHERE id IN (?, ?)",
      recoveryFixtureId,
      extraRecoveryFixtureId,
    );
    await prisma.$executeRawUnsafe(
      "DELETE FROM _prisma_migrations WHERE id = ?",
      fixtureId,
    );
    await prisma.$disconnect();
    rmSync(migrationRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(
    "migration classifier fixture 실패:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exit(1);
});
