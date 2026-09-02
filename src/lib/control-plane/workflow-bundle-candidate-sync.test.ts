import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { drainAutomationIngress, recordWebhookDelivery } from "@/lib/control-plane/automation-service";

import {
  durableIngressEnvelopeHash,
  parseDurableWorkflowBundleCandidate,
} from "@/lib/control-plane/automation-inbox";
import {
  durableWorkflowBundleCandidate,
  workflowBundleCandidateSourceKey,
  WORKFLOW_BUNDLE_CANDIDATE_SOURCE as SOURCE,
  type DurableWorkflowBundleCandidate,
} from "@/lib/control-plane/workflow-bundle-candidate-source";
import {
  backfillWorkflowBundleCandidates,
  enqueueWorkflowBundleCandidateReadback,
  syncWorkflowBundleCandidate,
} from "@/lib/control-plane/workflow-bundle-candidate-sync";

const SHA = "a".repeat(40);
const INPUT = {
  event: "workflow_run", action: "completed",
  repository: { id: Number(SOURCE.repositoryId), full_name: SOURCE.repository },
  workflowRun: { id: 123, path: SOURCE.workflowPath, status: "completed", conclusion: "success",
    event: "push", head_sha: SHA, head_branch: "main", run_attempt: 1 },
};
function observation(): DurableWorkflowBundleCandidate {
  const result = durableWorkflowBundleCandidate(INPUT);
  assert.ok(result);
  return result;
}

test("중앙 main 후보 성공만 공개 run identity로 변환하고 원문/인증값은 버린다", () => {
  const candidate = durableWorkflowBundleCandidate({
    ...INPUT,
    workflowRun: { ...INPUT.workflowRun, token: "must-not-be-kept" } as typeof INPUT.workflowRun,
  });
  assert.equal(candidate?.runId, "123");
  assert.equal(candidate?.sourceSha, SHA);
  assert.doesNotMatch(JSON.stringify(candidate), /must-not-be-kept|token/);
  assert.ok(durableWorkflowBundleCandidate({ ...INPUT, workflowRun: { ...INPUT.workflowRun, event: "workflow_dispatch" } }));
});

test("다른 repo/ID/path/branch, PR, 실패와 불완전/위조 identity는 수집하지 않는다", () => {
  for (const input of [
    { ...INPUT, event: "pull_request" },
    { ...INPUT, action: "requested" },
    { ...INPUT, repository: { ...INPUT.repository, id: 777 } },
    { ...INPUT, repository: { ...INPUT.repository, full_name: "seorilabs/other" } },
    ...[
      { path: ".github/workflows/workflow-bundle-candidate.yml" },
      { head_branch: "feature/main" }, { event: "pull_request" },
      { event: "pull_request_target" }, { conclusion: "failure" }, { status: "in_progress" },
      { run_attempt: undefined }, { run_attempt: 0 }, { head_sha: "invalid" },
      { id: Number.MAX_SAFE_INTEGER + 1 },
    ].map((change) => ({ ...INPUT, workflowRun: { ...INPUT.workflowRun, ...change } })),
  ]) assert.equal(durableWorkflowBundleCandidate(input), null);
});

test("후보 inbox는 delivery/repo/action/SHA checksum 전체를 다시 검증한다", () => {
  const payload = observation();
  const binding = { sourceKey: "github:delivery", event: "workflow_run", action: "completed", repoFullName: SOURCE.repository };
  const payloadHash = durableIngressEnvelopeHash({ ...binding, payload });
  assert.deepEqual(parseDurableWorkflowBundleCandidate({ ...binding, payload, payloadHash }), payload);
  for (const change of [
    { sourceKey: "github:another" }, { event: "push" }, { action: "requested" },
    { repoFullName: "seorilabs/other" }, { payloadHash: "0".repeat(64) },
    { payload: { ...payload, sourceSha: "b".repeat(40) } },
  ]) assert.throws(() => parseDurableWorkflowBundleCandidate({ ...binding, payload, payloadHash, ...change }));
});

function syncFixture() {
  const calls: Array<Record<string, unknown>> = [];
  let existing: { id: string; sourceSha: string } | null = null;
  let artifacts: unknown[] = [{ id: 456, name: `workflow-bundle-v5-candidate-${SHA}`, expired: false, size_in_bytes: 6000 }];
  let totalCount = 1;
  let claimAlive = true;
  let importError: Error | null = null;
  let concurrent = false;
  const dependencies: NonNullable<Parameters<typeof syncWorkflowBundleCandidate>[2]> = {
    async findExisting(sourceSha) { calls.push({ action: "read-existing", sourceSha }); return existing; },
    async listArtifacts() { calls.push({ action: "list" }); return { totalCount, artifacts }; },
    async importCandidate(input) {
      calls.push({ action: "import", ...input });
      if (concurrent) existing = { id: "concurrent-record", sourceSha: SHA };
      if (importError) throw importError;
      existing = { id: "candidate-record", sourceSha: SHA };
      return { ...existing, duplicate: false };
    },
  };
  const assertClaim = async () => { if (!claimAlive) throw new Error("claim lost with sensitive transport details"); };
  return { calls, dependencies, assertClaim,
    seed: () => { existing = { id: "manual-record", sourceSha: SHA }; },
    setArtifacts: (value: unknown[], count = value.length) => { artifacts = value; totalCount = count; },
    loseClaim: () => { claimAlive = false; },
    failImport: (error: Error, isConcurrent = false) => { importError = error; concurrent = isConcurrent; },
  };
}

test("수집은 exact run/attempt/artifact의 기존 import를 쓰고 두 번째 호출은 원장을 재사용한다", async () => {
  const f = syncFixture();
  const first = await syncWorkflowBundleCandidate(observation(), f.assertClaim, f.dependencies);
  const second = await syncWorkflowBundleCandidate(observation(), f.assertClaim, f.dependencies);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.id, second.id);
  assert.deepEqual(f.calls.filter((call) => call.action === "import"), [{
    action: "import", sourceSha: SHA, runId: 123n, runAttempt: 1, artifactId: 456n,
    idempotencyKey: "workflow-bundle-candidate:123:1:456", actor: "automation:workflow-bundle-candidate-sync",
  }]);
  assert.equal(f.calls.filter((call) => call.action === "list").length, 1);
});

test("수동 등록된 불변 후보는 Actions 파일의 보존 기한과 무관하게 재사용한다", async () => {
  const f = syncFixture();
  f.seed();
  f.setArtifacts([]);
  const result = await syncWorkflowBundleCandidate(observation(), f.assertClaim, f.dependencies);
  assert.deepEqual(result, { id: "manual-record", sourceSha: SHA, duplicate: true });
  assert.equal(f.calls.some((call) => call.action === "list" || call.action === "import"), false);
});

test("파일 누락/복수/다른 이름/만료/과대 파일은 import하지 않는다", async () => {
  const valid = { id: 456, name: `workflow-bundle-v5-candidate-${SHA}`, expired: false, size_in_bytes: 6000 };
  for (const [artifacts, count] of [
    [[], 0], [[valid, valid], 2], [[valid], 101],
    [[{ ...valid, name: "another" }], 1], [[{ ...valid, expired: true }], 1],
    [[{ ...valid, size_in_bytes: 4 * 1024 * 1024 + 1 }], 1],
  ] as Array<[unknown[], number]>) {
    const f = syncFixture(); f.setArtifacts(artifacts, count);
    await assert.rejects(syncWorkflowBundleCandidate(observation(), f.assertClaim, f.dependencies));
    assert.equal(f.calls.some((call) => call.action === "import"), false);
  }
});

test("파일 조회 중 claim을 잃으면 원장 쓰기 전에 중단한다", async () => {
  const f = syncFixture();
  const list = f.dependencies.listArtifacts;
  f.dependencies.listArtifacts = async (input) => { const value = await list(input); f.loseClaim(); return value; };
  await assert.rejects(syncWorkflowBundleCandidate(observation(), f.assertClaim, f.dependencies), {
    message: "WORKFLOW_BUNDLE_CANDIDATE_SYNC_FAILED",
  });
  assert.equal(f.calls.some((call) => call.action === "import"), false);
});

test("수동 import와 unique 경합하면 재조회하고 쓰기를 반복하지 않는다", async () => {
  const f = syncFixture();
  f.failImport(new Prisma.PrismaClientKnownRequestError("not exported", { code: "P2002", clientVersion: "test" }), true);
  assert.deepEqual(await syncWorkflowBundleCandidate(observation(), f.assertClaim, f.dependencies), {
    id: "concurrent-record", sourceSha: SHA, duplicate: true,
  });
  assert.equal(f.calls.filter((call) => call.action === "import").length, 1);
});

test("provider 실패의 URL/인증값은 inbox error로 흘러가지 않는다", async () => {
  const f = syncFixture();
  f.failImport(new Error("https://example.invalid?signature=CANARY_SECRET Authorization: CANARY_SECRET"));
  await assert.rejects(syncWorkflowBundleCandidate(observation(), f.assertClaim, f.dependencies), {
    message: "WORKFLOW_BUNDLE_CANDIDATE_SYNC_FAILED",
  });
});

test("누락 복구 inbox는 같은 run/attempt를 한 번만 기록하고 변경된 SHA는 거부한다", async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const client = { automationIngressEvent: {
    async createMany({ data }: { data: Array<Record<string, unknown>> }) {
      const row = data[0]; const key = String(row.sourceKey);
      if (rows.has(key)) return { count: 0 };
      rows.set(key, row); return { count: 1 };
    },
    async findUnique({ where }: { where: { sourceKey: string } }) { return rows.get(where.sourceKey) ?? null; },
  } };
  const results = await Promise.all([
    enqueueWorkflowBundleCandidateReadback(observation(), client as never),
    enqueueWorkflowBundleCandidateReadback(observation(), client as never),
  ]);
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true]);
  assert.equal(rows.size, 1);
  assert.equal(workflowBundleCandidateSourceKey(observation()), "reconcile:workflow-bundle:123:1");
  await assert.rejects(enqueueWorkflowBundleCandidateReadback({ ...observation(), sourceSha: "b".repeat(40) }, client as never),
    /INGRESS_BINDING_MISMATCH/);
});

test("누락 복구는 보존 기간의 지정 workflow 전체 페이지를 처리하고 중복을 집계한다", async () => {
  const pages: number[] = [];
  const queued: string[] = [];
  const result = await backfillWorkflowBundleCandidates(new Date("2026-09-02T00:00:00Z"), {
    async listPage(page, since) {
      pages.push(page); assert.equal(since, "2026-08-30T00:00:00.000Z");
      return { observations: [{ ...observation(), runId: String(page) }], hasMore: page < 3 };
    },
    async enqueue(input) { queued.push(input.runId); return { duplicate: input.runId === "2" }; },
  });
  assert.deepEqual(pages, [1, 2, 3]);
  assert.deepEqual(queued, ["1", "2", "3"]);
  assert.deepEqual(result, { scanned: 3, queued: 2 });
});

test("provider 무한 페이지와 조회 실패는 완료로 꾸미거나 오류 원문을 노출하지 않는다", async () => {
  let pages = 0;
  await assert.rejects(backfillWorkflowBundleCandidates(new Date(), {
    async listPage() { pages += 1; return { observations: [], hasMore: true }; },
    async enqueue() { return { duplicate: false }; },
  }), /BACKFILL_LIMIT_EXCEEDED/);
  assert.equal(pages, 10);
  await assert.rejects(backfillWorkflowBundleCandidates(new Date(), {
    async listPage() { throw new Error("CANARY_PRIVATE_URL"); },
    async enqueue() { throw new Error("must not enqueue"); },
  }), { message: "WORKFLOW_BUNDLE_CANDIDATE_SYNC_FAILED" });
});

test("webhook/기존 scheduler/복구는 같은 후보 수집에 연결되고 승인/출시 경로는 호출하지 않는다", () => {
  const webhook = readFileSync("src/app/api/webhooks/route.ts", "utf8");
  const automation = readFileSync("src/lib/control-plane/automation-service.ts", "utf8");
  const backfill = readFileSync("src/lib/sync/backfill.ts", "utf8");
  const sync = readFileSync("src/lib/control-plane/workflow-bundle-candidate-sync.ts", "utf8");
  assert.match(webhook, /recordWebhookDelivery\([\s\S]*workflowBundleCandidate/);
  assert.match(webhook, /stableTagObservation \|\| discoveryObservation \|\| workflowBundleCandidate/);
  assert.match(automation, /parseDurableWorkflowBundleCandidate[\s\S]*syncWorkflowBundleCandidate/);
  assert.match(backfill, /await backfillWorkflowBundleCandidates\(\)/);
  assert.match(sync, /verifyWorkflowBundleRegistryReadback/);
  assert.doesNotMatch(sync, /importWorkflowBundleApproval|activateConfig|createWorkflowDispatch|createRelease|createTag/);
});

test("실제 delivery/queue 서비스는 중복 알림·수집 실패·두 scheduler의 동시 재시도를 한 번씩 처리한다", async (t) => {
  const now = new Date("2026-09-02T00:00:00Z");
  const deliveries = new Map<string, Record<string, unknown>>();
  const rows = new Map<string, Record<string, unknown>>();
  const model = {
    async createMany({ data }: { data: Array<Record<string, unknown>> }) {
      const dataRow = data[0]; const key = String(dataRow.sourceKey);
      if (rows.has(key)) return { count: 0 };
      rows.set(key, { ...dataRow, id: `inbox-${rows.size}`, status: "PENDING", attempts: 0,
        issueNumber: dataRow.issueNumber ?? null, issueNodeId: dataRow.issueNodeId ?? null,
        createdAt: now, updatedAt: now, eligibleAt: now });
      return { count: 1 };
    },
    async findUnique({ where }: { where: { sourceKey: string } }) { return rows.get(where.sourceKey) ?? null; },
    async findMany({ where }: { where: { sourceKey?: string; OR: Array<{ eligibleAt?: { lte: Date }; updatedAt?: { lte: Date } }> } }) {
      return [...rows.values()].filter((row) => (!where.sourceKey || row.sourceKey === where.sourceKey)
        && (["PENDING", "FAILED"].includes(String(row.status)) && (row.eligibleAt as Date) <= where.OR[0].eligibleAt!.lte
          || row.status === "PROCESSING" && (row.updatedAt as Date) <= where.OR[1].updatedAt!.lte))
        .map((row) => ({ ...row }));
    },
    async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      const row = [...rows.values()].find((entry) => Object.entries(where).every(([key, value]) => entry[key] === value));
      if (!row) return { count: 0 };
      for (const [key, value] of Object.entries(data)) {
        row[key] = key === "attempts" ? Number(row.attempts) + (value as { increment: number }).increment : value;
      }
      return { count: 1 };
    },
  };
  const client = { automationIngressEvent: model, webhookDelivery: {
    async createMany({ data }: { data: Array<Record<string, unknown>> }) {
      const row = data[0]; const key = String(row.deliveryId);
      if (deliveries.has(key)) return { count: 0 };
      deliveries.set(key, row); return { count: 1 };
    },
    async findUnique({ where }: { where: { deliveryId: string } }) { return deliveries.get(where.deliveryId) ?? null; },
  } };
  // Prisma의 lazy proxy 메서드는 own descriptor가 없어 node mock.method 대신 값 경계를 복원한다.
  const originalTransaction = prisma.$transaction;
  const originalFindMany = prisma.automationIngressEvent.findMany;
  const originalUpdateMany = prisma.automationIngressEvent.updateMany;
  t.after(() => {
    prisma.$transaction = originalTransaction;
    prisma.automationIngressEvent.findMany = originalFindMany;
    prisma.automationIngressEvent.updateMany = originalUpdateMany;
  });
  prisma.$transaction = ((callback: (tx: typeof client) => Promise<unknown>) => callback(client)) as never;
  prisma.automationIngressEvent.findMany = model.findMany as never;
  prisma.automationIngressEvent.updateMany = model.updateMany as never;
  const input = { deliveryId: "candidate-delivery", event: "workflow_run", action: "completed", repoFullName: SOURCE.repository,
    workflowBundleCandidate: observation() };
  assert.deepEqual(await recordWebhookDelivery(input), { duplicate: false });
  assert.deepEqual(await recordWebhookDelivery(input), { duplicate: true });
  assert.equal(rows.size, 1);
  await assert.rejects(recordWebhookDelivery({ ...input, workflowBundleCandidate: { ...observation(), sourceSha: "b".repeat(40) } }),
    /durable payload/);

  const f = syncFixture();
  const list = f.dependencies.listArtifacts;
  let attempts = 0;
  f.dependencies.listArtifacts = async (candidate) => {
    attempts += 1;
    if (attempts === 1) throw new Error("CANARY_SECRET provider unavailable");
    return list(candidate);
  };
  const dependencies = {
    repositoryDiscoveryReadback: async () => { throw new Error("must not discover repository"); },
    workflowBundleCandidateImport: (candidate: DurableWorkflowBundleCandidate, claim: () => Promise<void>) =>
      syncWorkflowBundleCandidate(candidate, claim, f.dependencies),
  };
  const failed = await drainAutomationIngress({ now }, dependencies);
  assert.equal(failed.failed, 1);
  const row = [...rows.values()][0];
  assert.equal(row.status, "FAILED");
  assert.equal(row.error, "WORKFLOW_BUNDLE_CANDIDATE_SYNC_FAILED");
  const results = await Promise.all([
    drainAutomationIngress({ now: new Date(now.getTime() + 31_000) }, dependencies),
    drainAutomationIngress({ now: new Date(now.getTime() + 31_000) }, dependencies),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.processed, 0), 1);
  assert.equal(row.status, "PROCESSED");
  assert.equal(row.attempts, 2);
  assert.equal(f.calls.filter((call) => call.action === "import").length, 1);
  assert.doesNotMatch(JSON.stringify(row), /CANARY_SECRET/);
});
