import assert from "node:assert/strict";

import { Prisma, PrismaClient } from "@prisma/client";

if (process.env.MIGRATION_FIXTURE_ACK !== "LOCAL_SCHEMA_ONLY") {
  throw new Error("MIGRATION_FIXTURE_ACK=LOCAL_SCHEMA_ONLY가 필요하다");
}

const prisma = new PrismaClient();
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const IDS = [
  "test-backfill-source-a",
  "test-backfill-source-b",
  "test-backfill-hourly",
] as const;

interface ColumnRow {
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: "YES" | "NO";
  COLUMN_DEFAULT: string | null;
}

async function main(): Promise<void> {
  const columns = await prisma.$queryRaw<ColumnRow[]>`
    SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'control_plane_desired_state_backfill_run'
      AND COLUMN_NAME IN ('trigger', 'sourceSha')
  `;
  const byName = new Map(columns.map((column) => [column.COLUMN_NAME, column]));
  const trigger = byName.get("trigger");
  const sourceSha = byName.get("sourceSha");
  assert.ok(trigger);
  assert.match(trigger.COLUMN_TYPE, /^enum\(.+\)$/i);
  assert.match(trigger.COLUMN_TYPE, /HOURLY_CRON/i);
  assert.match(trigger.COLUMN_TYPE, /DEPLOY_CATCH_UP/i);
  assert.equal(trigger.IS_NULLABLE, "YES");
  assert.equal(trigger.COLUMN_DEFAULT, null);
  assert.ok(sourceSha);
  assert.equal(sourceSha.COLUMN_TYPE.toLowerCase(), "char(40)");
  assert.equal(sourceSha.IS_NULLABLE, "YES");

  await prisma.desiredStateBackfillRun.deleteMany({ where: { id: { in: [...IDS] } } });
  try {
    const common = {
      contractVersion: "desired-state-draft-backfill/v2",
      actor: "deploy:desired-state-backfill",
      status: "COMPLETED" as const,
      summary: { failed: 0 },
      completedAt: new Date("2026-08-29T03:30:00.000Z"),
    };
    await prisma.desiredStateBackfillRun.create({
      data: {
        ...common,
        id: IDS[0],
        idempotencyKey: `desired-state-backfill:deploy:${SHA_A}`,
        requestHash: "1".repeat(64),
        trigger: "DEPLOY_CATCH_UP",
        sourceSha: SHA_A,
      },
    });

    await assert.rejects(
      prisma.desiredStateBackfillRun.create({
        data: {
          ...common,
          id: "test-backfill-source-a-retry",
          idempotencyKey: `desired-state-backfill:deploy:${SHA_A}`,
          requestHash: "1".repeat(64),
          trigger: "DEPLOY_CATCH_UP",
          sourceSha: SHA_A,
        },
      }),
      (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002",
    );
    const replay = await prisma.desiredStateBackfillRun.findUniqueOrThrow({
      where: { idempotencyKey: `desired-state-backfill:deploy:${SHA_A}` },
    });
    assert.equal(replay.id, IDS[0]);
    assert.equal(replay.sourceSha, SHA_A);

    await prisma.desiredStateBackfillRun.create({
      data: {
        ...common,
        id: IDS[1],
        idempotencyKey: `desired-state-backfill:deploy:${SHA_B}`,
        requestHash: "2".repeat(64),
        trigger: "DEPLOY_CATCH_UP",
        sourceSha: SHA_B,
      },
    });
    await prisma.desiredStateBackfillRun.create({
      data: {
        ...common,
        id: IDS[2],
        actor: "scheduler:desired-state-backfill",
        idempotencyKey: "desired-state-backfill:hourly:2026082903",
        requestHash: "3".repeat(64),
        trigger: "HOURLY_CRON",
        sourceSha: null,
      },
    });

    const runs = await prisma.desiredStateBackfillRun.findMany({
      where: { id: { in: [...IDS] } },
      orderBy: { id: "asc" },
    });
    assert.equal(runs.length, 3);
    assert.deepEqual(
      new Set(runs.filter((run) => run.trigger === "DEPLOY_CATCH_UP").map((run) => run.sourceSha)),
      new Set([SHA_A, SHA_B]),
    );
  } finally {
    await prisma.desiredStateBackfillRun.deleteMany({
      where: { id: { in: [...IDS, "test-backfill-source-a-retry"] } },
    });
  }
}

main()
  .then(() => console.log("desired-state source-bound idempotency 계약 통과"))
  .finally(() => prisma.$disconnect());
