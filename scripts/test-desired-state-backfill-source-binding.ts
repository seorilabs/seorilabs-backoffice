import assert from "node:assert/strict";

import { Prisma, PrismaClient } from "@prisma/client";
import {
  claimPartialDesiredStateBackfill,
  desiredStateBackfillAdminInvocation,
  type DesiredStateBackfillSummary,
} from "../src/lib/control-plane/desired-state-backfill";

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
      contractVersion: "desired-state-safe-source-rebase/v3",
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
    const invocation = desiredStateBackfillAdminInvocation({
      trigger: "deploy-catch-up", sourceSha: SHA_A, now: new Date(),
    });
    const summary: DesiredStateBackfillSummary = {
      contractVersion: "desired-state-safe-source-rebase/v3", mode: "DRAFT_AND_SAFE_SOURCE_REBASE",
      activeApps: 0, draftCreated: 0, sourceRebasedAndActivated: 0, alreadyConfigured: 0,
      needsInput: 0, failed: 1, activationAttempted: false, providerMutationAttempted: false,
      deferredHumanOrProviderFields: ["PROJECT_BLUEPRINT_INCOMPLETE", "LOCALIZATION_UNOBSERVED", "COMPLIANCE_HUMAN_DRAFT_REQUIRED", "STORE_ASSET_CHECKSUM_UNOBSERVED"],
      items: [],
    };
    const completedAt = new Date("2026-10-04T12:00:00.000Z");
    await prisma.desiredStateBackfillRun.update({
      where: { id: IDS[0] }, data: { status: "PARTIAL", summary: summary as unknown as Prisma.InputJsonValue, completedAt },
    });
    const input = { id: IDS[0], completedAt, summary, invocation };
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimPartialDesiredStateBackfill(input, prisma)));
    assert.equal(claims.filter(Boolean).length, 1, "동시 재시도 중 하나만 claim해야 한다");
    const claimed = await prisma.desiredStateBackfillRun.findUniqueOrThrow({ where: { id: IDS[0] } });
    assert.equal(claimed.status, "RUNNING");
    assert.equal(claimed.completedAt, null);
    assert.deepEqual(claimed.summary, summary);
    const audit = await prisma.auditLog.findMany({ where: { entityId: IDS[0], action: "control-plane.desired-state-backfill.retry-started" } });
    assert.equal(audit.length, 1);
    assert.deepEqual((audit[0].payload as Record<string, unknown>).previousSummary, summary);
    // 더 최근에 종료된 PARTIAL을 오래된 요청이 가져갈 수 없다.
    await prisma.desiredStateBackfillRun.update({ where: { id: IDS[0] }, data: { status: "PARTIAL", completedAt: new Date(completedAt.getTime() + 1000) } });
    assert.equal(await claimPartialDesiredStateBackfill(input, prisma), false);
    await prisma.desiredStateBackfillRun.update({ where: { id: IDS[0] }, data: { status: "COMPLETED", completedAt } });
    assert.equal(await claimPartialDesiredStateBackfill(input, prisma), false);
  } finally {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...IDS] } } });
    await prisma.desiredStateBackfillRun.deleteMany({
      where: { id: { in: [...IDS, "test-backfill-source-a-retry"] } },
    });
  }
}

main()
  .then(() => console.log("desired-state source-bound idempotency 계약 통과"))
  .finally(() => prisma.$disconnect());
