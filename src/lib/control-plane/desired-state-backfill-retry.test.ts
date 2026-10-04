import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import {
  DESIRED_STATE_BACKFILL_CONTRACT_VERSION,
  DESIRED_STATE_BACKFILL_MODE,
  desiredStateBackfillAdminInvocation,
  desiredStateBackfillFailureCode,
  desiredStateBackfillRequestHash,
  runDesiredStateDraftBackfill,
  type DesiredStateBackfillSummary,
} from "@/lib/control-plane/desired-state-backfill";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

const invocation = desiredStateBackfillAdminInvocation({
  trigger: "deploy-catch-up", sourceSha: "a".repeat(40), now: new Date(),
});
const previousSummary: DesiredStateBackfillSummary = {
  contractVersion: DESIRED_STATE_BACKFILL_CONTRACT_VERSION,
  mode: DESIRED_STATE_BACKFILL_MODE,
  activeApps: 1, draftCreated: 0, sourceRebasedAndActivated: 0,
  alreadyConfigured: 0, needsInput: 0, failed: 1,
  activationAttempted: false, providerMutationAttempted: false,
  deferredHumanOrProviderFields: ["PROJECT_BLUEPRINT_INCOMPLETE", "LOCALIZATION_UNOBSERVED", "COMPLIANCE_HUMAN_DRAFT_REQUIRED", "STORE_ASSET_CHECKSUM_UNOBSERVED"],
  items: [{ appId: "app", slug: "sample", repoFullName: "test/sample", repoId: null,
    outcome: "FAILED", reason: "INTERNAL_ERROR", detail: null,
    sourceObservationId: null, configRevisionId: null, revision: null,
    verifiedProjectionCounts: { markets: 0, localizations: 0, complianceDrafts: 0, storeAssets: 0, projectBlueprints: 0 },
  }],
};

test("부분 실패를 다시 평가하고 기존 실패 감사와 사람 입력 gate를 보존한다", async (t) => {
  const row = {
    id: "run", ...invocation, requestHash: desiredStateBackfillRequestHash(invocation),
    status: "PARTIAL", summary: structuredClone(previousSummary), completedAt: new Date() as Date | null,
  };
  const audits: Array<{ action: string; payload: Record<string, unknown> }> = [];
  let reads = 0;
  let readError: Error | null = null;
  let auditError = false;
  let claimed = false;
  const tx = {
    desiredStateBackfillRun: {
      create: async () => { throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" }); },
      updateMany: async () => { claimed = true; row.status = "RUNNING"; row.completedAt = null; return { count: 1 }; },
      update: async ({ data }: { data: Partial<typeof row> }) => Object.assign(row, data),
    },
    auditLog: { create: async ({ data }: { data: typeof audits[number] }) => {
      if (auditError) throw new Error("audit unavailable");
      audits.push(structuredClone(data));
    } },
    repositoryRegistration: { findMany: async () => [] },
    app: { findMany: async () => {
      reads++;
      if (readError) throw readError;
      // 현재 repo binding이 없으면 기존 정책대로 사람 입력이 필요하다.
      return [{ id: "app", slug: "sample", repoFullName: "test/sample", repoId: null,
        status: "ACTIVE", configRevisions: [], discoveryObservations: [], buildTargets: [] }];
    } },
  };
  const originalTransaction = prisma.$transaction;
  const originalFind = prisma.desiredStateBackfillRun.findUniqueOrThrow;
  t.after(() => {
    prisma.$transaction = originalTransaction;
    prisma.desiredStateBackfillRun.findUniqueOrThrow = originalFind;
  });
  prisma.$transaction = (async (fn: (client: unknown) => Promise<unknown>) => {
    const snapshot = structuredClone(row);
    const length = audits.length;
    try { return await fn(tx); }
    catch (error) { Object.assign(row, snapshot); audits.length = length; throw error; }
  }) as typeof prisma.$transaction;
  prisma.desiredStateBackfillRun.findUniqueOrThrow = (async () => structuredClone(row)) as unknown as typeof prisma.desiredStateBackfillRun.findUniqueOrThrow;

  const result = await runDesiredStateDraftBackfill(invocation, { signingKey: "unused" });
  assert.equal(claimed, true);
  assert.equal(result.runId, "run");
  assert.equal(result.duplicate, false);
  assert.equal(result.state, "completed");
  assert.equal(result.failed, 0);
  assert.equal(result.items[0].reason, "APP_REPO_ID_MISSING");
  assert.deepEqual(audits[0].payload.previousSummary, previousSummary);
  assert.equal(audits[0].action, "control-plane.desired-state-backfill.retry-started");
  assert.equal(audits[1].action, "control-plane.desired-state-backfill.completed");
  const readCount = reads;
  assert.equal((await runDesiredStateDraftBackfill(invocation, { signingKey: "unused" })).duplicate, true);
  assert.equal(reads, readCount, "완료된 run은 다시 설정을 평가하지 않는다");

  row.status = "RUNNING";
  const busy = await runDesiredStateDraftBackfill(invocation, { signingKey: "unused" });
  assert.equal(busy.state, "busy");
  assert.equal(reads, readCount);

  row.status = "PARTIAL";
  row.summary = structuredClone(previousSummary);
  row.completedAt = new Date();
  readError = new Error("private exception message");
  await assert.rejects(runDesiredStateDraftBackfill(invocation, { signingKey: "unused" }), readError);
  assert.equal(row.status, "PARTIAL");
  assert.deepEqual(row.summary, previousSummary);
  assert.ok(row.completedAt);
  assert.equal(audits.at(-1)?.action, "control-plane.desired-state-backfill.retry-failed");
  assert.equal(audits.at(-1)?.payload.errorCode, null);
  assert.equal(JSON.stringify(audits).includes("private exception message"), false);

  auditError = true;
  await assert.rejects(runDesiredStateDraftBackfill(invocation, { signingKey: "unused" }), /audit unavailable/);
  assert.equal(row.status, "PARTIAL", "감사 기록 실패 시 claim도 rollback한다");
  auditError = false;
  const auditCount = audits.length;
  await assert.rejects(runDesiredStateDraftBackfill({ ...invocation, sourceSha: "b".repeat(40) }, { signingKey: "unused" }),
    (error) => error instanceof ControlPlaneError && error.code === "IDEMPOTENCY_CONFLICT");
  assert.equal(audits.length, auditCount);
});

test("오류 메시지를 저장하지 않고 알려진 오류 코드만 기록한다", () => {
  assert.equal(desiredStateBackfillFailureCode(new Error("secret")), null);
  assert.equal(desiredStateBackfillFailureCode({ code: "secret" }), null);
  assert.equal(desiredStateBackfillFailureCode(new ControlPlaneError("secret", 409, "REVISION_CONFLICT")), "REVISION_CONFLICT");
  assert.equal(desiredStateBackfillFailureCode(new Prisma.PrismaClientKnownRequestError("secret", { code: "P2034", clientVersion: "test" })), "P2034");
});
