import { Prisma } from "@prisma/client";
import { z } from "zod";

import { durableIngressEnvelopeHash, type AutomationIngressClaimCheck } from "@/lib/control-plane/automation-inbox";
import { ControlPlaneError } from "@/lib/control-plane/service";
import {
  durableWorkflowBundleCandidate,
  durableWorkflowBundleCandidateSchema,
  workflowBundleCandidateSourceKey,
  WORKFLOW_BUNDLE_CANDIDATE_SOURCE as SOURCE,
  type DurableWorkflowBundleCandidate,
} from "@/lib/control-plane/workflow-bundle-candidate-source";
import {
  importWorkflowBundleCandidate,
  verifyWorkflowBundleRegistryReadback,
} from "@/lib/control-plane/workflow-bundle-v5-registry";
import { withWorkflowBundleRegistryReadClient } from "@/lib/github/workflow-bundle-registry-client";
import { prisma } from "@/lib/prisma";

const artifactSchema = z.object({
  id: z.number().int().positive().safe(),
  name: z.string(),
  expired: z.boolean(),
  size_in_bytes: z.number().int().positive().max(4 * 1024 * 1024),
});

type CandidateResult = { id: string; sourceSha: string; duplicate: boolean };
type SyncDependencies = {
  findExisting: (sourceSha: string) => Promise<Omit<CandidateResult, "duplicate"> | null>;
  listArtifacts: (observation: DurableWorkflowBundleCandidate) => Promise<{ totalCount: number; artifacts: unknown[] }>;
  importCandidate: (
    input: Parameters<typeof importWorkflowBundleCandidate>[0],
    assertClaim: AutomationIngressClaimCheck,
  ) => Promise<CandidateResult>;
};

function publicFailure(error: unknown): Error {
  const code = error instanceof ControlPlaneError ? error.code : error instanceof Error ? error.message : "";
  return new Error(/^(?:FLEET_GITHUB|WORKFLOW_BUNDLE)_[A-Z0-9_]{1,120}$/.test(code)
    ? code
    : "WORKFLOW_BUNDLE_CANDIDATE_SYNC_FAILED");
}

const defaultSyncDependencies: SyncDependencies = {
  async findExisting(sourceSha) {
    const records = await prisma.workflowBundleRegistryRecord.findMany({
      where: { registryId: SOURCE.registryId, sourceSha, approvalState: "CANDIDATE" },
      take: 2,
    });
    if (records.length > 1) throw new Error("WORKFLOW_BUNDLE_CANDIDATE_REGISTRY_AMBIGUOUS");
    if (!records.length) return null;
    const record = records[0];
    verifyWorkflowBundleRegistryReadback(record, "");
    return { id: record.id, sourceSha: record.sourceSha };
  },
  async listArtifacts(observation) {
    return withWorkflowBundleRegistryReadClient(async (client) => {
      const response = await client.rest.actions.listWorkflowRunArtifacts({
        owner: "seorilabs",
        repo: ".github",
        run_id: Number(observation.runId),
        name: `workflow-bundle-v5-candidate-${observation.sourceSha}`,
        per_page: 100,
      });
      return { totalCount: response.data.total_count, artifacts: response.data.artifacts };
    });
  },
  async importCandidate(input, assertClaim) {
    const result = await importWorkflowBundleCandidate({ ...input, assertWriteAllowed: assertClaim });
    return { id: result.record.id, sourceSha: result.record.sourceSha, duplicate: result.duplicate };
  },
};

/** Webhook과 누락 복구는 같은 immutable registry import만 호출한다. 설정 활성화/승인은 없다. */
export async function syncWorkflowBundleCandidate(
  input: DurableWorkflowBundleCandidate,
  assertClaim: AutomationIngressClaimCheck,
  dependencies: SyncDependencies = defaultSyncDependencies,
): Promise<CandidateResult> {
  try {
    const observation = durableWorkflowBundleCandidateSchema.parse(input);
    await assertClaim();
    // 보존 기한이 지난 Actions 파일을 다시 요구하지 않는다. 이미 검증된 불변 원장이 정본이다.
    const existing = await dependencies.findExisting(observation.sourceSha);
    await assertClaim();
    if (existing) return { ...existing, duplicate: true };

    const page = await dependencies.listArtifacts(observation);
    if (page.totalCount !== 1 || page.artifacts.length !== 1) {
      throw new Error("WORKFLOW_BUNDLE_CANDIDATE_ARTIFACT_NOT_UNIQUE");
    }
    const artifact = artifactSchema.parse(page.artifacts[0]);
    if (artifact.name !== `workflow-bundle-v5-candidate-${observation.sourceSha}` || artifact.expired) {
      throw new Error("WORKFLOW_BUNDLE_CANDIDATE_ARTIFACT_UNAVAILABLE");
    }
    await assertClaim();
    try {
      return await dependencies.importCandidate({
        sourceSha: observation.sourceSha,
        runId: BigInt(observation.runId),
        runAttempt: observation.runAttempt,
        artifactId: BigInt(artifact.id),
        idempotencyKey: `workflow-bundle-candidate:${observation.runId}:${observation.runAttempt}:${artifact.id}`,
        actor: "automation:workflow-bundle-candidate-sync",
      }, assertClaim);
    } catch (error) {
      // 수동 import/다른 delivery와 경합해도 이미 만들어진 원장을 검증해 재사용한다.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        await assertClaim();
        const concurrent = await dependencies.findExisting(observation.sourceSha);
        if (concurrent) return { ...concurrent, duplicate: true };
      }
      throw error;
    }
  } catch (error) {
    // provider 오류 객체의 signed URL/header 등을 durable inbox error에 남기지 않는다.
    throw publicFailure(error);
  }
}

type IngressClient = Pick<typeof prisma, "automationIngressEvent">;

export async function enqueueWorkflowBundleCandidateReadback(
  input: DurableWorkflowBundleCandidate,
  client: IngressClient = prisma,
): Promise<{ duplicate: boolean }> {
  const observation = durableWorkflowBundleCandidateSchema.parse(input);
  const binding = {
    sourceKey: workflowBundleCandidateSourceKey(observation),
    event: "workflow_run",
    action: "completed",
    repoFullName: observation.repository,
  };
  const payloadHash = durableIngressEnvelopeHash({ ...binding, payload: observation });
  const inserted = await client.automationIngressEvent.createMany({
    data: [{ ...binding, payload: observation, payloadHash, occurredAt: new Date() }],
    skipDuplicates: true,
  });
  const existing = await client.automationIngressEvent.findUnique({ where: { sourceKey: binding.sourceKey } });
  if (
    !existing
    || existing.event !== binding.event
    || existing.action !== binding.action
    || existing.repoFullName !== binding.repoFullName
    || existing.payloadHash !== payloadHash
  ) throw new Error("WORKFLOW_BUNDLE_CANDIDATE_INGRESS_BINDING_MISMATCH");
  return { duplicate: inserted.count === 0 };
}

type BackfillDependencies = {
  listPage: (page: number, since: string) => Promise<{ observations: DurableWorkflowBundleCandidate[]; hasMore: boolean }>;
  enqueue: typeof enqueueWorkflowBundleCandidateReadback;
};

const defaultBackfillDependencies: BackfillDependencies = {
  async listPage(page, since) {
    return withWorkflowBundleRegistryReadClient(async (client) => {
      const response = await client.rest.actions.listWorkflowRuns({
        owner: "seorilabs",
        repo: ".github",
        workflow_id: SOURCE.workflowPath,
        branch: "main",
        status: "success",
        created: `>=${since}`,
        per_page: 100,
        page,
      });
      return {
        hasMore: response.data.workflow_runs.length === 100,
        observations: response.data.workflow_runs.flatMap((run) => {
          const observation = durableWorkflowBundleCandidate({
            event: "workflow_run", action: "completed", repository: run.repository, workflowRun: run,
          });
          return observation ? [observation] : [];
        }),
      };
    });
  },
  enqueue: enqueueWorkflowBundleCandidateReadback,
};

/** 전체 repo의 최근 50건이 아닌 지정 workflow의 보존 기간 전체를 조회해 유실을 복구한다. */
export async function backfillWorkflowBundleCandidates(
  now = new Date(),
  dependencies: BackfillDependencies = defaultBackfillDependencies,
): Promise<{ scanned: number; queued: number }> {
  try {
    const since = new Date(now.getTime() - 3 * 24 * 60 * 60_000).toISOString();
    let scanned = 0;
    let queued = 0;
    for (let page = 1; page <= 10; page += 1) {
      const result = await dependencies.listPage(page, since);
      for (const observation of result.observations) {
        scanned += 1;
        if (!(await dependencies.enqueue(observation)).duplicate) queued += 1;
      }
      if (!result.hasMore) return { scanned, queued };
    }
    throw new Error("WORKFLOW_BUNDLE_CANDIDATE_BACKFILL_LIMIT_EXCEEDED");
  } catch (error) {
    throw publicFailure(error);
  }
}
