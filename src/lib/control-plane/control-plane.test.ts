import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  eligibleForAutopilot,
  firstSuccessfulClaim,
  validSettlementLease,
} from "@/lib/control-plane/agent-queue";
import {
  agentExecutionPolicy,
  agentRepositorySingletonScope,
  automationPolicy,
} from "@/lib/control-plane/automation-catalog";
import { canonicalJson, signSnapshot, verifySnapshot } from "@/lib/control-plane/json";
import {
  assertActivationPreconditions,
  ControlPlaneError,
} from "@/lib/control-plane/service";
import { registrationStatus } from "@/lib/control-plane/repository-registration";

test("snapshot 서명은 object key 순서와 무관하게 재현된다", () => {
  const left = { revision: 2, config: { b: true, a: "value" } };
  const right = { config: { a: "value", b: true }, revision: 2 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  const signed = signSnapshot(left, "test-signing-key");
  assert.deepEqual(signed, signSnapshot(right, "test-signing-key"));
  assert.equal(verifySnapshot(right, "test-signing-key", signed.digest, signed.signature), true);
  assert.equal(verifySnapshot({ ...right, revision: 3 }, "test-signing-key", signed.digest, signed.signature), false);
});

test("activation은 expected ACTIVE revision이 다르면 optimistic concurrency로 거부한다", () => {
  assert.throws(
    () => assertActivationPreconditions({
      actualActiveRevision: 3,
      expectedActiveRevision: 2,
      targetStatus: "DRAFT",
    }),
    (error) => error instanceof ControlPlaneError && error.code === "REVISION_CONFLICT" && error.status === 409,
  );
});

test("ACTIVE 또는 SUPERSEDED revision은 다시 activation할 수 없다", () => {
  for (const targetStatus of ["ACTIVE", "SUPERSEDED"] as const) {
    assert.throws(
      () => assertActivationPreconditions({
        actualActiveRevision: 1,
        expectedActiveRevision: 1,
        targetStatus,
      }),
      (error) => error instanceof ControlPlaneError && error.code === "IMMUTABLE_REVISION",
    );
  }
});

test("legacy shadow import가 만든 DRAFT는 payload가 유효해도 activation할 수 없다", () => {
  assert.throws(
    () => assertActivationPreconditions({
      actualActiveRevision: 1,
      expectedActiveRevision: 1,
      targetStatus: "DRAFT",
      shadowImportId: "legacy-import-1",
    }),
    (error) => error instanceof ControlPlaneError
      && error.code === "SHADOW_IMPORT_NOT_ACTIVATABLE"
      && error.status === 409,
  );
});

test("동시에 claim한 두 worker 중 CAS 성공 worker 하나만 lease를 얻는다", async () => {
  let claimed = false;
  const tryClaim = async (runId: string) => {
    await Promise.resolve();
    if (claimed) return null;
    claimed = true;
    return { runId };
  };
  const [first, second] = await Promise.all([
    firstSuccessfulClaim(["run-1"], tryClaim),
    firstSuccessfulClaim(["run-1"], tryClaim),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);
});

test("stale generation completion과 비활성 lease를 거부한다", () => {
  assert.equal(validSettlementLease({
    runStatus: "RUNNING",
    currentGeneration: 3,
    requestedGeneration: 2,
    leaseActive: true,
  }), false);
  assert.equal(validSettlementLease({
    runStatus: "RUNNING",
    currentGeneration: 3,
    requestedGeneration: 3,
    leaseActive: false,
  }), false);
  assert.equal(validSettlementLease({
    runStatus: "RUNNING",
    currentGeneration: 3,
    requestedGeneration: 3,
    leaseActive: true,
  }), true);
});

test("자율 PR scope는 repo별 하나이며 blocked/approval/closed issue는 제외한다", () => {
  const readyPr = agentExecutionPolicy(automationPolicy({ approvalPolicy: "READY_PR", budgetCeilingMicros: 1 }), "START");
  const readOnly = agentExecutionPolicy(automationPolicy({ approvalPolicy: "READ_ONLY", budgetCeilingMicros: 1 }), "START");
  assert.equal(agentRepositorySingletonScope("seorilabs/Happy-Farm", readyPr), "repo-pr:seorilabs/happy-farm");
  assert.equal(agentRepositorySingletonScope("seorilabs/Happy-Farm", readOnly), null);
  assert.equal(eligibleForAutopilot({ issueNumber: 1, issueState: "CLOSED", labels: [] }), false);
  assert.equal(eligibleForAutopilot({ issueNumber: 1, issueState: "OPEN", labels: ["blocked"] }), false);
  assert.equal(eligibleForAutopilot({ issueNumber: 1, issueState: "OPEN", labels: ["approval:release"] }), false);
  assert.equal(eligibleForAutopilot({ issueNumber: 1, issueState: "OPEN", labels: ["P1"] }), false);
  assert.equal(eligibleForAutopilot({ issueNumber: 1, issueState: "OPEN", labels: ["autopilot", "P1"] }), true);
});

test("repository registration은 다중 후보와 archive를 명시 상태로 보존한다", () => {
  assert.equal(registrationStatus({ archived: false, managed: false, candidateCount: 2 }), "NEEDS_INPUT");
  assert.equal(registrationStatus({ archived: true, managed: true }), "ARCHIVED");
  assert.equal(registrationStatus({ archived: false, managed: true }), "MANAGED");
});

test("migration이 webhook/occurrence 멱등과 repo PR unique scope를 DB에서 강제한다", () => {
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
  const migration = readFileSync(
    join(
      process.cwd(),
      "prisma/migrations/00000000000000_squashed_migrations/migration.sql",
    ),
    "utf8",
  );
  assert.match(schema, /model WebhookDelivery[\s\S]*deliveryId String\s+@id/);
  assert.match(schema, /model AutomationOccurrence[\s\S]*idempotencyKey String\s+@unique/);
  assert.match(migration, /UNIQUE INDEX `automation_occurrence_definitionId_scheduledFor_key`/);
  assert.match(migration, /UNIQUE INDEX `agent_lease_scopeKey_key`/);
  assert.match(migration, /UNIQUE INDEX `agent_run_event_requestId_key`/);
});

test("provider observation migration은 MySQL utf8mb4 인덱스 한도를 넘지 않는다", () => {
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
  const migration = readFileSync(
    join(
      process.cwd(),
      "prisma/migrations/00000000000000_squashed_migrations/migration.sql",
    ),
    "utf8",
  );
  const oversizedColumns = "`appId`, `provider`, `resourceType`, `resourceId`, `payloadHash`";

  assert.doesNotMatch(migration, new RegExp(oversizedColumns));
  assert.doesNotMatch(
    schema,
    /@@index\(\[appId, provider, resourceType, resourceId, payloadHash\]\)/,
  );
  assert.match(
    migration,
    /INDEX `control_plane_provider_observation_appId_provider_observedAt_idx`\(`appId`, `provider`, `observedAt`\)/,
  );
  assert.match(schema, /@@index\(\[appId, provider, observedAt\]\)/);
});
