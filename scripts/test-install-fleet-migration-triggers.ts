/**
 * MySQL 9.2 migration contract fixture에서 trusted-operator DDL 경계를 재현한다.
 * production에서는 k8s/fleet-migration-security-provisioning-job.yaml만 사용한다.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  FLEET_MIGRATION_APPEND_ONLY_TRIGGERS,
  REQUIRED_APPEND_ONLY_TRIGGERS,
  appendOnlyCreateTriggerStatement,
  verifyAppendOnlyTriggers,
  type ObservedTrigger,
} from "@/lib/control-plane/append-only-triggers";
import { prisma } from "@/lib/prisma";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!new Set(["127.0.0.1", "localhost"]).has(databaseUrl.hostname)) {
  throw new Error("Fleet migration trigger fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("Fleet migration trigger fixture DB 이름은 _contract_test로 끝나야 한다");
}
const prismaCommand = existsSync(join(process.cwd(), "node_modules/.bin/prisma"))
  ? join(process.cwd(), "node_modules/.bin/prisma")
  : "prisma";

function executeTriggerDdl(statement: string): void {
  const result = spawnSync(
    prismaCommand,
    ["db", "execute", "--stdin", "--schema", join(process.cwd(), "prisma/schema.prisma")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl.toString(),
        PRISMA_HIDE_UPDATE_MESSAGE: "1",
      },
      input: `${statement};\n`,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) throw new Error("Fleet migration test trigger DDL 실패");
}

async function observed(): Promise<ObservedTrigger[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{
    name: string;
    tableName: string;
    event: string;
    timing: string;
    statement: string;
  }>>(`
    SELECT
      TRIGGER_NAME AS name,
      EVENT_OBJECT_TABLE AS tableName,
      EVENT_MANIPULATION AS event,
      ACTION_TIMING AS timing,
      ACTION_STATEMENT AS statement
    FROM information_schema.TRIGGERS
    WHERE TRIGGER_SCHEMA = DATABASE()
    ORDER BY TRIGGER_NAME
  `);
  return rows.map((row) => ({
    name: row.name,
    table: row.tableName,
    event: row.event,
    timing: row.timing,
    statement: row.statement,
  }));
}

async function main(): Promise<void> {
  const before = await observed();
  const fleetTables = new Set(FLEET_MIGRATION_APPEND_ONLY_TRIGGERS.map(({ table }) => table));
  const fleetBefore = before.filter(({ table }) => fleetTables.has(table));
  if (fleetBefore.length === 0) {
    for (const requirement of FLEET_MIGRATION_APPEND_ONLY_TRIGGERS) {
      executeTriggerDdl(appendOnlyCreateTriggerStatement(requirement));
    }
  } else {
    verifyAppendOnlyTriggers(fleetBefore, FLEET_MIGRATION_APPEND_ONLY_TRIGGERS);
  }
  const after = await observed();
  const verified = verifyAppendOnlyTriggers(after, REQUIRED_APPEND_ONLY_TRIGGERS);
  process.stdout.write(`Fleet migration test trigger 계약 통과: verified=${verified}\n`);
}

main()
  .catch((error: unknown) => {
    console.error(
      "Fleet migration test trigger 계약 실패:",
      error instanceof Error ? error.message : "unknown error",
    );
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
