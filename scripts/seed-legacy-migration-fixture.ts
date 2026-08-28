import assert from "node:assert/strict";
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
const verifyCutover = process.argv.includes("--verify-cutover");

const DEFINITION_ID = "legacy-cutover-definition";
const OCCURRENCE_ID = "legacy-cutover-occurrence";
const RUN_ID = "legacy-cutover-run";
const REPOSITORY_ID = 8_900_000_099n;
const FIXTURE_TIME = new Date("2026-08-28T00:00:00.000Z");

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

async function seedApplicationRows(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO automation_definition
      (id, \`key\`, appId, template, schedule, enabled, maxAttempts, createdAt, updatedAt)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    DEFINITION_ID,
    "legacy-cutover-definition-key",
    "LEGACY_AUTOPILOT",
    "0 */4 * * *",
    true,
    4,
    FIXTURE_TIME,
    FIXTURE_TIME,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO automation_occurrence
      (id, definitionId, scheduledFor, idempotencyKey, status, createdAt, completedAt)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    OCCURRENCE_ID,
    DEFINITION_ID,
    FIXTURE_TIME,
    "legacy-cutover-occurrence-key",
    "PENDING",
    FIXTURE_TIME,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO agent_run
      (id, occurrenceId, appId, repoFullName, issueNumber, issueState, labels,
       createsPr, priority, status, leaseGeneration, attempts, maxAttempts,
       eligibleAt, startedAt, completedAt, outcome, error, createdAt, updatedAt)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
    RUN_ID,
    OCCURRENCE_ID,
    "seorilabs/legacy-cutover-fixture",
    321,
    "OPEN",
    JSON.stringify(["autopilot", "P1"]),
    true,
    7,
    "PENDING",
    2,
    1,
    5,
    FIXTURE_TIME,
    FIXTURE_TIME,
    FIXTURE_TIME,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO repository_registration
      (repoId, repoFullName, defaultBranch, archived, status, discoveryCandidates,
       lastDefaultPushSha, lastDeliveryId, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    REPOSITORY_ID,
    "seorilabs/legacy-cutover-fixture",
    "main",
    false,
    "MANAGED",
    JSON.stringify([{ profile: "react-native", workingDirectory: "." }]),
    "a".repeat(40),
    "legacy-cutover-delivery",
    FIXTURE_TIME,
    FIXTURE_TIME,
  );
}

async function verifyApplicationRows(prisma: PrismaClient): Promise<void> {
  const [definition] = await prisma.$queryRawUnsafe<Array<{
    id: string;
    key: string;
    template: string;
    schedule: string;
    enabled: bigint;
    maxAttempts: number;
    agentKind: string | null;
    model: string | null;
    configuration: unknown;
    pausedAt: Date | null;
    cancelledAt: Date | null;
  }>>(`
    SELECT id, \`key\`, template, schedule, CAST(enabled AS UNSIGNED) AS enabled,
           maxAttempts, agentKind, model, configuration, pausedAt, cancelledAt
    FROM automation_definition WHERE id = ?
  `, DEFINITION_ID);
  assert.equal(definition?.id, DEFINITION_ID);
  assert.equal(definition.key, "legacy-cutover-definition-key");
  assert.equal(definition.template, "LEGACY_AUTOPILOT");
  assert.equal(definition.schedule, "0 */4 * * *");
  assert.equal(Number(definition.enabled), 1);
  assert.equal(definition.maxAttempts, 4);
  assert.deepEqual(
    [definition.agentKind, definition.model, definition.configuration, definition.pausedAt, definition.cancelledAt],
    [null, null, null, null, null],
  );

  const [occurrence] = await prisma.$queryRawUnsafe<Array<{
    id: string;
    definitionId: string;
    idempotencyKey: string;
    status: string;
    triggerKind: string | null;
    triggerKey: string | null;
    result: unknown;
  }>>(`
    SELECT id, definitionId, idempotencyKey, status, triggerKind, triggerKey, result
    FROM automation_occurrence WHERE id = ?
  `, OCCURRENCE_ID);
  assert.equal(occurrence?.definitionId, DEFINITION_ID);
  assert.equal(occurrence.idempotencyKey, "legacy-cutover-occurrence-key");
  assert.equal(occurrence.status, "PENDING");
  assert.deepEqual([occurrence.triggerKind, occurrence.triggerKey, occurrence.result], [null, null, null]);

  const [run] = await prisma.$queryRawUnsafe<Array<{
    id: string;
    occurrenceId: string;
    repoFullName: string;
    issueNumber: number;
    issueState: string;
    firstLabel: string;
    createsPr: bigint;
    priority: number;
    status: string;
    leaseGeneration: number;
    attempts: number;
    maxAttempts: number;
    workKey: string | null;
    spentMicros: bigint | null;
    readbackRequestedAt: Date | null;
    cancelledAt: Date | null;
  }>>(`
    SELECT id, occurrenceId, repoFullName, issueNumber, issueState,
           JSON_UNQUOTE(JSON_EXTRACT(labels, '$[0]')) AS firstLabel,
           CAST(createsPr AS UNSIGNED) AS createsPr, priority, status,
           leaseGeneration, attempts, maxAttempts, workKey, spentMicros,
           readbackRequestedAt, cancelledAt
    FROM agent_run WHERE id = ?
  `, RUN_ID);
  assert.equal(run?.occurrenceId, OCCURRENCE_ID);
  assert.equal(run.repoFullName, "seorilabs/legacy-cutover-fixture");
  assert.equal(run.issueNumber, 321);
  assert.equal(run.issueState, "OPEN");
  assert.equal(run.firstLabel, "autopilot");
  assert.equal(Number(run.createsPr), 1);
  assert.deepEqual(
    [run.priority, run.status, run.leaseGeneration, run.attempts, run.maxAttempts],
    [7, "PENDING", 2, 1, 5],
  );
  assert.deepEqual(
    [run.workKey, run.spentMicros, run.readbackRequestedAt, run.cancelledAt],
    [null, null, null, null],
  );

  const [registration] = await prisma.$queryRawUnsafe<Array<{
    repoId: bigint;
    repoFullName: string;
    defaultBranch: string;
    archived: bigint;
    status: string;
    lastDefaultPushSha: string;
    lastDeliveryId: string;
    managementKind: string | null;
    reconcileGeneration: number | null;
    lastReconciledSha: string | null;
    lastDiscoveryReason: string | null;
  }>>(`
    SELECT repoId, repoFullName, defaultBranch, CAST(archived AS UNSIGNED) AS archived,
           status, lastDefaultPushSha, lastDeliveryId, managementKind,
           reconcileGeneration, lastReconciledSha, lastDiscoveryReason
    FROM repository_registration WHERE repoId = ?
  `, REPOSITORY_ID);
  assert.equal(registration?.repoId, REPOSITORY_ID);
  assert.equal(registration.repoFullName, "seorilabs/legacy-cutover-fixture");
  assert.equal(registration.defaultBranch, "main");
  assert.equal(Number(registration.archived), 0);
  assert.equal(registration.status, "MANAGED");
  assert.equal(registration.lastDefaultPushSha, "a".repeat(40));
  assert.equal(registration.lastDeliveryId, "legacy-cutover-delivery");
  assert.deepEqual(
    [registration.managementKind, registration.reconcileGeneration, registration.lastReconciledSha, registration.lastDiscoveryReason],
    [null, null, null, null],
  );
  console.log("legacy application row cutover 계약 통과");
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    if (verifyCutover) {
      await verifyApplicationRows(prisma);
      return;
    }
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
    await seedApplicationRows(prisma);
    console.log(`legacy migration fixture 생성: rows=${rows.length}, applicationRows=4`);
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
