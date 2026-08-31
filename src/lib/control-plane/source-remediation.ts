import { Prisma } from "@prisma/client";

import {
  eligibleForAutopilot,
  parseSourceRemediationPolicy,
  SOURCE_REMEDIATION_ELIGIBLE_REASON_CODES,
  SOURCE_REMEDIATION_TEMPLATE_KEY,
  sourceRemediationAutomationPolicy,
  type AutomationAgentKind,
  type SourceRemediationEligibleReasonCode,
  type SourceRemediationPolicy,
} from "@/lib/control-plane/automation-catalog";
import { repositoryAutomationEligible } from "@/lib/control-plane/repository-registration";
import { definitionKey } from "@/lib/control-plane/automation";
import {
  beginAutomationMutation,
  completeAutomationMutation,
} from "@/lib/control-plane/automation-mutation";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

const ACTOR = /^[A-Za-z0-9_.:@/-]{1,128}$/;
const ELIGIBLE_REASON_SET = new Set<string>(SOURCE_REMEDIATION_ELIGIBLE_REASON_CODES);

function issueWorkKey(repoFullName: string, issueNumber: number): string {
  return `issue:${repoFullName.toLowerCase()}#${issueNumber}`;
}

/**
 * 정의 생성 시점의 issue 제목+라벨을 잠근다. claim 시 같은 digest가 아니면 임의 편집으로
 * scope가 넓어졌다고 보고 fail-closed한다. GitHub 원문 body는 이 mirror에 없어 대상에서
 * 제외한다 — 이 template은 이미 P1+autopilot+단일 issue로 좁혀진 대상만 다룬다.
 */
export function sourceRemediationScopeDigest(input: {
  title: string;
  labels: readonly string[];
}): string {
  return jsonDigest({
    title: input.title,
    labels: [...input.labels].map((label) => label.toLowerCase()).sort(),
  } as JsonValue);
}

/**
 * 일반 repositoryAutomationEligible(MANAGED)과 독립된 좁은 gate다. classification=PRODUCT_APP로
 * 이미 확정됐지만 discovery가 NO_CANDIDATE/BUILD_TARGET_MISSING NEEDS_INPUT인 repository만
 * 통과하며, 정의 생성 시 잠근 generation/source SHA/reason과 정확히 같을 때만 허용한다.
 */
export function repositorySourceRemediationEligible(
  registration: {
    archived: boolean;
    status: string;
    classification: string | null;
    reconcileGeneration: number | null;
    lastReconciledSha: string | null;
    lastDefaultPushSha: string | null;
    lastDiscoveryReason: string | null;
  } | null,
  policy: Pick<SourceRemediationPolicy, "discoveryGeneration" | "sourceSha" | "reasonCode">,
): boolean {
  if (!registration || registration.archived || registration.status !== "NEEDS_INPUT") return false;
  if (registration.classification !== "PRODUCT_APP") return false;
  if (!ELIGIBLE_REASON_SET.has(policy.reasonCode)) return false;
  if (registration.lastDiscoveryReason !== policy.reasonCode) return false;
  if ((registration.reconcileGeneration ?? 0) !== policy.discoveryGeneration) return false;
  const currentSha = (registration.lastReconciledSha ?? registration.lastDefaultPushSha)?.toLowerCase() ?? null;
  return currentSha !== null && currentSha === policy.sourceSha.toLowerCase();
}

/**
 * claim과 dead-letter 수동 retry가 같은 registration 판정을 쓰도록 template 분기를 한 곳에 모은다.
 * source-remediation은 registration이 NEEDS_INPUT으로 남아 있는 유일한 template이라 일반
 * MANAGED guard로는 영원히 통과할 수 없다. 그 외 모든 template은 기존
 * repositoryAutomationEligible을 그대로 사용한다.
 */
export function templateRepositoryAutomationEligible(input: {
  template: string;
  configuration: unknown;
  registration: {
    archived: boolean;
    status: string;
    managementKind: string | null;
    classification?: string | null;
    reconcileGeneration?: number | null;
    lastDefaultPushSha: string | null;
    lastReconciledSha: string | null;
    lastDiscoveryReason?: string | null;
  } | null;
}): boolean {
  if (input.template !== SOURCE_REMEDIATION_TEMPLATE_KEY) {
    return repositoryAutomationEligible(input.registration);
  }
  const policy = parseSourceRemediationPolicy(input.configuration);
  if (!policy) return false;
  const registration = input.registration;
  if (!registration) return false;
  return repositorySourceRemediationEligible({
    archived: registration.archived,
    status: registration.status,
    classification: registration.classification ?? null,
    reconcileGeneration: registration.reconcileGeneration ?? null,
    lastReconciledSha: registration.lastReconciledSha,
    lastDefaultPushSha: registration.lastDefaultPushSha,
    lastDiscoveryReason: registration.lastDiscoveryReason ?? null,
  }, policy);
}

/** claim 직전 GitHub 미러 재확인: 상태/라벨/우선순위/scope digest 중 하나라도 어긋나면 거부한다. */
export function issueEligibleForSourceRemediation(
  issue: {
    number: number;
    state: string | null;
    labels: unknown;
    title: string;
    priority: string | null;
    isAutopilot: boolean;
    isBlocked: boolean;
  } | null,
  policy: Pick<SourceRemediationPolicy, "issueNumber" | "scopeDigest">,
): boolean {
  if (!issue || issue.number !== policy.issueNumber || issue.isBlocked || !issue.isAutopilot) return false;
  if (issue.priority !== "P1") return false;
  if (!eligibleForAutopilot({ issueNumber: issue.number, issueState: issue.state, labels: issue.labels })) {
    return false;
  }
  const labels = Array.isArray(issue.labels)
    ? issue.labels.filter((label): label is string => typeof label === "string")
    : [];
  return sourceRemediationScopeDigest({ title: issue.title, labels }) === policy.scopeDigest;
}

export interface CreateSourceRemediationDefinitionInput {
  repoId: bigint;
  issueNumber: number;
  agentKind: AutomationAgentKind;
  budgetCeilingMicros: number;
  model?: string;
  maxAttempts: number;
  actor: string;
  /** issue.source가 BACKOFFICE가 아닐 때만 필요한 사람/승인된 AI 검증자. */
  verifiedBy?: string;
  idempotencyKey: string;
}

/**
 * source-remediation AutomationDefinition과 그 유일한 occurrence/AgentRun을 한 번에 만든다.
 * repository는 NEEDS_INPUT으로 남아 있으므로 assertRepositoryAutomationManaged를 거치지 않고,
 * 대신 이 함수 안에서만 유효한 exact-binding 검증을 수행한다. 다른 template의 MANAGED guard는
 * 건드리지 않는다.
 */
export async function createSourceRemediationDefinition(input: CreateSourceRemediationDefinitionInput): Promise<{
  definition: { id: string; key: string; template: string };
  runId: string | null;
  duplicate: boolean;
}> {
  if (!ACTOR.test(input.actor)) {
    throw new ControlPlaneError("actor가 유효하지 않습니다.", 400, "ACTOR_INVALID");
  }
  if (input.verifiedBy !== undefined && !ACTOR.test(input.verifiedBy)) {
    throw new ControlPlaneError("verifiedBy가 유효하지 않습니다.", 400, "VERIFIED_BY_INVALID");
  }

  const mutationRequest = {
    repoId: input.repoId.toString(),
    issueNumber: input.issueNumber,
    agentKind: input.agentKind,
    budgetCeilingMicros: input.budgetCeilingMicros,
    model: input.model ?? null,
    maxAttempts: input.maxAttempts,
  } satisfies JsonValue;
  const mutationIdentity = {
    requestId: input.idempotencyKey,
    actor: input.actor,
    operation: "CREATE",
    targetKey: `source-remediation:${input.repoId.toString()}:${input.issueNumber}`,
    request: mutationRequest,
  } as const;
  const mutation = await beginAutomationMutation(mutationIdentity);
  if (mutation.replay) {
    const replay = mutation.replay as { definitionId?: string; runId?: string | null };
    const definition = replay.definitionId
      ? await prisma.automationDefinition.findUnique({ where: { id: replay.definitionId } })
      : null;
    if (!definition) {
      throw new ControlPlaneError("완료된 source-remediation 생성 원장의 대상을 찾을 수 없습니다.", 409, "MUTATION_TARGET_MISSING");
    }
    return {
      definition: { id: definition.id, key: definition.key, template: definition.template },
      runId: replay.runId ?? null,
      duplicate: true,
    };
  }

  const app = await prisma.app.findUnique({
    where: { repoId: input.repoId },
    select: { id: true, repoFullName: true, status: true },
  });
  if (!app || app.status !== "ACTIVE") {
    throw new ControlPlaneError("ACTIVE PRODUCT_APP을 찾을 수 없습니다.", 404, "APP_NOT_ELIGIBLE");
  }
  const registration = await prisma.repositoryRegistration.findUnique({
    where: { repoId: input.repoId },
    select: {
      archived: true,
      status: true,
      classification: true,
      reconcileGeneration: true,
      lastReconciledSha: true,
      lastDefaultPushSha: true,
      lastDiscoveryReason: true,
    },
  });
  if (
    !registration
    || registration.archived
    || registration.status !== "NEEDS_INPUT"
    || registration.classification !== "PRODUCT_APP"
    || !ELIGIBLE_REASON_SET.has(registration.lastDiscoveryReason ?? "")
  ) {
    throw new ControlPlaneError(
      "explicit PRODUCT_APP decision이 있고 discovery가 NO_CANDIDATE/BUILD_TARGET_MISSING NEEDS_INPUT인 repository만 source-remediation 대상입니다.",
      409,
      "SOURCE_REMEDIATION_NOT_ELIGIBLE",
    );
  }
  const sourceSha = (registration.lastReconciledSha ?? registration.lastDefaultPushSha)?.toLowerCase() ?? null;
  if (!sourceSha) {
    throw new ControlPlaneError("discovery source SHA가 없습니다.", 409, "SOURCE_REMEDIATION_SOURCE_SHA_MISSING");
  }

  const issue = await prisma.issueMirror.findUnique({
    where: { repoFullName_number: { repoFullName: app.repoFullName, number: input.issueNumber } },
    select: {
      number: true,
      state: true,
      labels: true,
      title: true,
      priority: true,
      isAutopilot: true,
      isBlocked: true,
      source: true,
      appId: true,
    },
  });
  if (!issue || issue.state !== "OPEN" || issue.isBlocked || !issue.isAutopilot || issue.priority !== "P1") {
    throw new ControlPlaneError(
      "open, P1, autopilot이고 blocked/no-autopilot/approval label이 없는 issue만 대상입니다.",
      409,
      "SOURCE_REMEDIATION_ISSUE_NOT_ELIGIBLE",
    );
  }
  if (!eligibleForAutopilot({ issueNumber: issue.number, issueState: issue.state, labels: issue.labels })) {
    throw new ControlPlaneError("issue가 autopilot 대상이 아닙니다.", 409, "SOURCE_REMEDIATION_ISSUE_NOT_ELIGIBLE");
  }
  const createdByBackoffice = issue.source === "BACKOFFICE";
  if (!createdByBackoffice && !input.verifiedBy) {
    throw new ControlPlaneError(
      "Backoffice가 생성하지 않은 issue는 명시적 검증자(verifiedBy)가 필요합니다.",
      409,
      "SOURCE_REMEDIATION_ISSUE_UNVERIFIED",
    );
  }
  const labels = Array.isArray(issue.labels)
    ? issue.labels.filter((label): label is string => typeof label === "string")
    : [];
  const scopeDigest = sourceRemediationScopeDigest({ title: issue.title, labels });

  const consumed = await prisma.agentRun.findUnique({
    where: { workKey: issueWorkKey(app.repoFullName, issue.number) },
    select: { id: true },
  });
  if (consumed) {
    throw new ControlPlaneError("이 issue는 이미 다른 run이 소비했습니다.", 409, "SOURCE_REMEDIATION_WORK_ALREADY_CLAIMED");
  }

  const configuration = sourceRemediationAutomationPolicy({
    budgetCeilingMicros: input.budgetCeilingMicros,
    issueNumber: issue.number,
    discoveryGeneration: registration.reconcileGeneration ?? 0,
    sourceSha,
    reasonCode: registration.lastDiscoveryReason as SourceRemediationEligibleReasonCode,
    scopeDigest,
  });
  const key = definitionKey({
    appId: app.id,
    template: SOURCE_REMEDIATION_TEMPLATE_KEY,
    agentKind: input.agentKind,
    cadence: "MANUAL",
  });
  const existing = await prisma.automationDefinition.findUnique({ where: { key } });
  if (existing) {
    throw new ControlPlaneError("이 repository의 source-remediation routine이 이미 존재합니다.", 409, "DEFINITION_CONFLICT");
  }

  let created: { definition: { id: string; key: string; template: string }; runId: string | null };
  try {
    created = await prisma.$transaction(async (tx) => {
      const definition = await tx.automationDefinition.create({
        data: {
          key,
          appId: app.id,
          template: SOURCE_REMEDIATION_TEMPLATE_KEY,
          schedule: null,
          agentKind: input.agentKind,
          model: input.model,
          configuration: configuration as unknown as Prisma.InputJsonValue,
          maxAttempts: input.maxAttempts,
        },
      });
      const occurrence = await tx.automationOccurrence.create({
        data: {
          definitionId: definition.id,
          scheduledFor: new Date(),
          idempotencyKey: `source-remediation:${definition.id}:dispatch`,
          triggerKind: "MANUAL",
          triggerKey: `${definition.id}:dispatch`,
          runs: {
            create: {
              appId: issue.appId ?? app.id,
              repoFullName: app.repoFullName,
              issueNumber: issue.number,
              workKey: issueWorkKey(app.repoFullName, issue.number),
              issueState: issue.state,
              labels,
              createsPr: true,
              priority: 1,
              maxAttempts: input.maxAttempts,
              taskInput: {
                kind: "SOURCE_REMEDIATION",
                reasonCode: registration.lastDiscoveryReason,
                discoveryGeneration: registration.reconcileGeneration ?? 0,
                sourceSha,
              } as unknown as Prisma.InputJsonValue,
            },
          },
        },
        include: { runs: true },
      });
      return { definition, runId: occurrence.runs[0]?.id ?? null };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ControlPlaneError(
        "동시 요청이 같은 repository 또는 issue의 source-remediation 대상을 먼저 선점했습니다.",
        409,
        "SOURCE_REMEDIATION_CONFLICT",
      );
    }
    throw error;
  }

  await completeAutomationMutation({
    ...mutationIdentity,
    requestHash: mutation.requestHash,
    response: { definitionId: created.definition.id, runId: created.runId },
    audit: {
      action: "source-remediation.create",
      entityType: "AutomationDefinition",
      entityId: created.definition.id,
      payload: {
        ...mutationRequest,
        discoveryGeneration: registration.reconcileGeneration ?? 0,
        sourceSha,
        reasonCode: registration.lastDiscoveryReason,
        scopeDigest,
        issueSource: issue.source,
        verifiedBy: input.verifiedBy ?? null,
      } as unknown as JsonValue,
    },
  });

  return {
    definition: { id: created.definition.id, key: created.definition.key, template: created.definition.template },
    runId: created.runId,
    duplicate: false,
  };
}
