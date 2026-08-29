import { Prisma } from "@prisma/client";

import {
  agentExecutionPolicy,
  agentRepositorySingletonScope,
  parseManagedWorkerPolicy,
} from "@/lib/control-plane/automation-catalog";
import type { AgentGithubObservation } from "@/lib/control-plane/contracts";
import { githubInstallationProviderPayloadSchema } from "@/lib/control-plane/github-installation-observation";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { repositoryAutomationEligible } from "@/lib/control-plane/repository-registration";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

export const GITHUB_READY_PR_MUTATION_ACTION = "GITHUB_READY_PR_MUTATE" as const;
const OBSERVATION_MAX_AGE_MS = 60_000;
const OBSERVATION_FUTURE_SKEW_MS = 5_000;
const GRANT_TTL_MS = 5 * 60_000;

function normalizedLabels(labels: readonly string[]): string[] {
  return labels.map((label) => label.toLowerCase()).sort();
}

export function githubIssueEligible(issue: AgentGithubObservation["issue"]): boolean {
  if (!issue || issue.state !== "OPEN") return false;
  const labels = normalizedLabels(issue.labels);
  return labels.includes("autopilot")
    && !labels.some((label) => label === "blocked" || label === "no-autopilot" || label.startsWith("approval:"));
}

export function githubObservationTimingError(observedAt: Date, now: Date): string | null {
  if (observedAt.getTime() > now.getTime() + OBSERVATION_FUTURE_SKEW_MS) return "GITHUB_OBSERVATION_FROM_FUTURE";
  if (now.getTime() - observedAt.getTime() > OBSERVATION_MAX_AGE_MS) return "GITHUB_OBSERVATION_STALE";
  return null;
}

export function githubInstallationBindingError(input: {
  expected: { resourceId: string; payload: unknown } | null;
  observedInstallationId: string;
}): string | null {
  if (!input.expected) return "GITHUB_INSTALLATION_OBSERVATION_MISSING";
  const parsed = githubInstallationProviderPayloadSchema.safeParse(input.expected.payload);
  if (!parsed.success) return "GITHUB_INSTALLATION_OBSERVATION_INVALID";
  if (
    input.expected.resourceId !== input.observedInstallationId
    || parsed.data.attributes.installationId !== input.observedInstallationId
  ) return "GITHUB_INSTALLATION_BINDING_MISMATCH";
  if (parsed.data.attributes.capabilities.callerBootstrapPullRequest.state !== "GRANTED") {
    return "GITHUB_INSTALLATION_MUTATION_CAPABILITY_MISSING";
  }
  return null;
}

export function agentWorkerSessionStateError(input: {
  sessionId: string;
  sessionRunId: string;
  sessionGeneration: number;
  sessionPrincipalId: string;
  sessionRuntimeBindingDigest: string;
  sessionRepoId: bigint;
  sessionRepoFullName: string;
  sessionIssueNumber: number | null;
  sessionSourceSha: string;
  sessionExpiresAt: Date;
  sessionRevokedAt: Date | null;
  requestedPrincipalId: string;
  requestedRuntimeBindingDigest: string;
  leaseRunId: string;
  leaseGeneration: number;
  leaseWorkerId: string;
  leaseExpiresAt: Date;
  leaseRevokedAt: Date | null;
  runStatus: string;
  runGeneration: number;
  runRepoFullName: string;
  runIssueNumber: number | null;
  now: Date;
}): string | null {
  if (input.sessionPrincipalId !== input.requestedPrincipalId || input.leaseWorkerId !== input.requestedPrincipalId) {
    return "SESSION_PRINCIPAL_MISMATCH";
  }
  if (
    !/^[0-9a-f]{64}$/.test(input.sessionRuntimeBindingDigest)
    || input.sessionRuntimeBindingDigest !== input.requestedRuntimeBindingDigest
  ) return "SESSION_RUNTIME_BINDING_MISMATCH";
  if (
    input.sessionRunId !== input.leaseRunId
    || input.sessionGeneration !== input.leaseGeneration
    || input.sessionGeneration !== input.runGeneration
    || input.sessionRepoFullName.toLowerCase() !== input.runRepoFullName.toLowerCase()
    || input.sessionIssueNumber !== input.runIssueNumber
    || input.sessionRepoId <= 0n
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.sessionRepoFullName)
    || !/^[0-9a-f]{40}$/.test(input.sessionSourceSha)
    || (input.sessionIssueNumber !== null && input.sessionIssueNumber <= 0)
  ) return "SESSION_BINDING_MISMATCH";
  if (
    input.runStatus !== "RUNNING"
    || input.sessionRevokedAt
    || input.leaseRevokedAt
    || input.sessionExpiresAt <= input.now
    || input.leaseExpiresAt <= input.now
  ) return "STALE_SESSION";
  return null;
}

function observationJson(observation: AgentGithubObservation): JsonValue {
  return {
    schemaVersion: 1,
    githubInstallationId: observation.githubInstallationId,
    providerSnapshotId: observation.providerSnapshotId,
    complete: true,
    pageCount: observation.pageCount,
    terminalCursor: null,
    observedAt: observation.observedAt.toISOString(),
    repoId: observation.repoId,
    repoFullName: observation.repoFullName,
    defaultBranchRef: observation.defaultBranchRef,
    defaultBranchSha: observation.defaultBranchSha.toLowerCase(),
    issue: observation.issue ? {
      number: observation.issue.number,
      nodeId: observation.issue.nodeId,
      state: observation.issue.state,
      labels: normalizedLabels(observation.issue.labels),
      updatedAt: observation.issue.updatedAt.toISOString(),
    } : null,
    openAutopilotPullRequests: observation.openAutopilotPullRequests.map((pullRequest) => ({
      ...pullRequest,
      headSha: pullRequest.headSha.toLowerCase(),
      baseSha: pullRequest.baseSha.toLowerCase(),
    })),
    mutationTarget: observation.mutationTarget ? {
      ...observation.mutationTarget,
      headSha: observation.mutationTarget.headSha?.toLowerCase() ?? null,
      pullRequests: observation.mutationTarget.pullRequests.map((pullRequest) => ({
        ...pullRequest,
        headSha: pullRequest.headSha.toLowerCase(),
        baseSha: pullRequest.baseSha.toLowerCase(),
      })),
    } : null,
  };
}

function mutationRequestDigest(input: {
  sessionId: string;
  workerPrincipalId: string;
  workerRuntimeBindingDigest: string;
  action: typeof GITHUB_READY_PR_MUTATION_ACTION;
  mutationIntentDigest: string;
  adapterPrincipalId: string;
  adapterRuntimeIdentity: string;
  observation: AgentGithubObservation;
}): string {
  return jsonDigest({
    sessionId: input.sessionId,
    workerPrincipalId: input.workerPrincipalId,
    workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
    action: input.action,
    mutationIntentDigest: input.mutationIntentDigest.toLowerCase(),
    adapterPrincipalId: input.adapterPrincipalId,
    adapterRuntimeIdentity: input.adapterRuntimeIdentity,
    observation: observationJson(input.observation),
  });
}

function readbackRequestDigest(input: {
  executionId: string;
  workerPrincipalId: string;
  workerRuntimeBindingDigest: string;
  adapterPrincipalId: string;
  adapterRuntimeIdentity: string;
  observation: AgentGithubObservation;
}): string {
  return jsonDigest({
    executionId: input.executionId,
    workerPrincipalId: input.workerPrincipalId,
    workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
    adapterPrincipalId: input.adapterPrincipalId,
    adapterRuntimeIdentity: input.adapterRuntimeIdentity,
    observation: observationJson(input.observation),
  });
}

function assertFreshObservation(observation: AgentGithubObservation, now: Date): void {
  const error = githubObservationTimingError(observation.observedAt, now);
  if (error) throw new ControlPlaneError("GitHub observation이 JIT 권한 발급에 사용할 만큼 최신이 아닙니다.", 409, error);
}

function assertSessionState(
  session: {
    id: string;
    runId: string;
    generation: number;
    principalId: string;
    runtimeBindingDigest: string;
    repoId: bigint;
    repoFullName: string;
    issueNumber: number | null;
    sourceSha: string;
    expiresAt: Date;
    revokedAt: Date | null;
    lease: {
      runId: string;
      generation: number;
      workerId: string;
      expiresAt: Date;
      revokedAt: Date | null;
      run: { status: string; leaseGeneration: number; repoFullName: string; issueNumber: number | null };
    };
  },
  principalId: string,
  runtimeBindingDigest: string,
  now: Date,
): void {
  const error = agentWorkerSessionStateError({
    sessionId: session.id,
    sessionRunId: session.runId,
    sessionGeneration: session.generation,
    sessionPrincipalId: session.principalId,
    sessionRuntimeBindingDigest: session.runtimeBindingDigest,
    sessionRepoId: session.repoId,
    sessionRepoFullName: session.repoFullName,
    sessionIssueNumber: session.issueNumber,
    sessionSourceSha: session.sourceSha,
    sessionExpiresAt: session.expiresAt,
    sessionRevokedAt: session.revokedAt,
    requestedPrincipalId: principalId,
    requestedRuntimeBindingDigest: runtimeBindingDigest,
    leaseRunId: session.lease.runId,
    leaseGeneration: session.lease.generation,
    leaseWorkerId: session.lease.workerId,
    leaseExpiresAt: session.lease.expiresAt,
    leaseRevokedAt: session.lease.revokedAt,
    runStatus: session.lease.run.status,
    runGeneration: session.lease.run.leaseGeneration,
    runRepoFullName: session.lease.run.repoFullName,
    runIssueNumber: session.lease.run.issueNumber,
    now,
  });
  if (error) throw new ControlPlaneError("agent worker session binding이 유효하지 않습니다.", 409, error);
}

function assertPreMutationObservation(input: {
  observation: AgentGithubObservation;
  session: {
    repoId: bigint;
    repoFullName: string;
    issueNumber: number | null;
    sourceSha: string;
  };
  registration: {
    repoId: bigint;
    repoFullName: string;
    defaultBranch: string | null;
    lastDefaultPushSha: string | null;
    archived: boolean;
    status: string;
    managementKind: string | null;
    classification: string | null;
    lastReconciledSha: string | null;
  };
}): void {
  const { observation, session, registration } = input;
  if (
    !repositoryAutomationEligible(registration)
    || !registration.defaultBranch
    || observation.repoId !== session.repoId.toString()
    || observation.repoFullName.toLowerCase() !== session.repoFullName.toLowerCase()
    || registration.repoId !== session.repoId
    || registration.repoFullName.toLowerCase() !== session.repoFullName.toLowerCase()
    || observation.defaultBranchRef !== `refs/heads/${registration.defaultBranch}`
    || observation.defaultBranchSha.toLowerCase() !== session.sourceSha.toLowerCase()
    || registration.lastDefaultPushSha?.toLowerCase() !== session.sourceSha.toLowerCase()
    || observation.openAutopilotPullRequests.length !== 0
    || observation.mutationTarget !== null
  ) {
    throw new ControlPlaneError("GitHub JIT observation의 repository/source/singleton binding이 다릅니다.", 409, "GITHUB_MUTATION_OBSERVATION_MISMATCH");
  }
  if (session.issueNumber === null) {
    if (observation.issue !== null) {
      throw new ControlPlaneError("issue 없는 run에 GitHub issue가 결합되었습니다.", 409, "GITHUB_MUTATION_ISSUE_MISMATCH");
    }
  } else if (observation.issue?.number !== session.issueNumber || !githubIssueEligible(observation.issue)) {
    throw new ControlPlaneError("GitHub issue가 현재 autopilot 대상이 아닙니다.", 409, "GITHUB_MUTATION_ISSUE_INELIGIBLE");
  }
}

function publicAuthorization(grant: {
  action: string;
  mutationIntentDigest: string;
  expectedHeadRef: string;
  expectedPullRequestMarker: string;
  expiresAt: Date;
  execution: { id: string; status: string } | null;
}, duplicate: boolean) {
  if (!grant.execution) throw new ControlPlaneError("consumed grant execution을 찾을 수 없습니다.", 409, "MUTATION_EXECUTION_MISSING");
  return {
    executionId: grant.execution.id,
    action: grant.action,
    mutationIntentDigest: grant.mutationIntentDigest,
    expectedHeadRef: grant.expectedHeadRef,
    expectedPullRequestMarker: grant.expectedPullRequestMarker,
    expiresAt: grant.expiresAt,
    status: grant.execution.status,
    writeDisposition: duplicate ? "READBACK_ONLY" as const : "EXECUTE_ONCE" as const,
    duplicate,
  };
}

export async function authorizeGithubReadyPrMutation(input: {
  sessionId: string;
  workerPrincipalId: string;
  workerRuntimeBindingDigest: string;
  action: typeof GITHUB_READY_PR_MUTATION_ACTION;
  mutationIntentDigest: string;
  observation: AgentGithubObservation;
  adapterPrincipalId: string;
  adapterRuntimeIdentity: string;
  idempotencyKey: string;
  now?: Date;
  retryAttempt?: number;
}) {
  const now = input.now ?? new Date();
  const bindingDigest = mutationRequestDigest(input);
  const replay = await prisma.agentActionGrant.findUnique({
    where: { requestId: input.idempotencyKey },
    include: { execution: true },
  });
  if (replay) {
    if (replay.bindingDigest !== bindingDigest || replay.sessionId !== input.sessionId || replay.action !== input.action) {
      throw new ControlPlaneError("idempotency key가 다른 mutation authorization에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return publicAuthorization(replay, true);
  }
  assertFreshObservation(input.observation, now);
  try {
    return await prisma.$transaction(async (tx) => {
      const session = await tx.agentWorkerSession.findUnique({
        where: { id: input.sessionId },
        include: {
          lease: {
            include: {
              run: { include: { occurrence: { include: { definition: true } }, repoGuard: true } },
            },
          },
        },
      });
      if (!session) throw new ControlPlaneError("agent worker session을 찾을 수 없습니다.", 404, "SESSION_NOT_FOUND");
      assertSessionState(session, input.workerPrincipalId, input.workerRuntimeBindingDigest, now);
      const run = session.lease.run;
      if (run.readbackRequestedAt) {
        throw new ControlPlaneError("READBACK_FIRST session은 새 mutation을 시작할 수 없습니다.", 409, "READBACK_MUTATION_FORBIDDEN");
      }
      const policy = parseManagedWorkerPolicy(run.occurrence.definition);
      const executionPolicy = policy ? agentExecutionPolicy(policy, "START") : null;
      if (!executionPolicy || executionPolicy.mutationAction !== input.action) {
        throw new ControlPlaneError("definition action policy가 GitHub mutation을 허용하지 않습니다.", 409, "ACTION_POLICY_VIOLATION");
      }
      const singletonScope = agentRepositorySingletonScope(session.repoFullName, executionPolicy);
      if (!singletonScope || run.repoGuard?.activeScopeKey !== singletonScope) {
        throw new ControlPlaneError("repo READY_PR singleton을 현재 run이 보유하지 않습니다.", 409, "REPO_SINGLETON_NOT_OWNED");
      }
      const registration = await tx.repositoryRegistration.findUnique({
        where: { repoId: session.repoId },
        select: {
          repoId: true,
          repoFullName: true,
          defaultBranch: true,
          archived: true,
          status: true,
          managementKind: true,
          classification: true,
          lastDefaultPushSha: true,
          lastReconciledSha: true,
        },
      });
      if (!registration) throw new ControlPlaneError("repository registration을 찾을 수 없습니다.", 409, "REPOSITORY_NOT_MANAGED");
      if (!run.appId) {
        throw new ControlPlaneError("agent run의 app binding을 찾을 수 없습니다.", 409, "RUN_APP_BINDING_MISSING");
      }
      const expectedInstallation = await tx.providerObservation.findFirst({
        where: {
          appId: run.appId,
          provider: "github",
          resourceType: "github-app-installation",
        },
        orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }],
        select: { resourceId: true, payload: true },
      });
      const installationError = githubInstallationBindingError({
        expected: expectedInstallation,
        observedInstallationId: input.observation.githubInstallationId,
      });
      if (installationError) {
        throw new ControlPlaneError(
          "GitHub mutation adapter installation이 중앙 provider observation과 일치하지 않습니다.",
          409,
          installationError,
        );
      }
      assertPreMutationObservation({ observation: input.observation, session, registration });
      const existingAction = await tx.agentActionGrant.findUnique({
        where: { runId_generation_action: { runId: run.id, generation: session.generation, action: input.action } },
        include: { execution: true },
      });
      if (existingAction) {
        throw new ControlPlaneError("이 run generation의 mutation grant는 이미 소비되었습니다.", 409, "MUTATION_ALREADY_AUTHORIZED");
      }
      const expiresAt = new Date(Math.min(now.getTime() + GRANT_TTL_MS, session.expiresAt.getTime()));
      if (expiresAt <= now) throw new ControlPlaneError("session이 JIT grant 발급 전에 만료되었습니다.", 409, "STALE_SESSION");
      const observation = await tx.agentGithubObservation.create({
        data: {
          sessionId: session.id,
          phase: "PRE_MUTATION",
          adapterPrincipalId: input.adapterPrincipalId,
          adapterRuntimeIdentity: input.adapterRuntimeIdentity,
          githubInstallationId: input.observation.githubInstallationId,
          providerSnapshotId: input.observation.providerSnapshotId,
          pageCount: input.observation.pageCount,
          repoId: session.repoId,
          repoFullName: session.repoFullName,
          defaultBranchRef: input.observation.defaultBranchRef,
          defaultBranchSha: input.observation.defaultBranchSha.toLowerCase(),
          issueNumber: input.observation.issue?.number ?? null,
          issueNodeId: input.observation.issue?.nodeId ?? null,
          issueState: input.observation.issue?.state ?? null,
          issueLabels: input.observation.issue?.labels ?? Prisma.JsonNull,
          issueUpdatedAt: input.observation.issue?.updatedAt ?? null,
          openAutopilotPullRequests: input.observation.openAutopilotPullRequests as Prisma.InputJsonValue,
          mutationTarget: Prisma.JsonNull,
          payloadDigest: jsonDigest(observationJson(input.observation)),
          observedAt: input.observation.observedAt,
        },
      });
      const expectedHeadRef = `refs/heads/seori/run-${run.id.slice(0, 20)}-${session.generation}`;
      const expectedPullRequestMarker = `seori-run:${run.id}:${session.generation}`;
      const grant = await tx.agentActionGrant.create({
        data: {
          sessionId: session.id,
          observationId: observation.id,
          runId: run.id,
          generation: session.generation,
          principalId: session.principalId,
          adapterPrincipalId: input.adapterPrincipalId,
          adapterRuntimeIdentity: input.adapterRuntimeIdentity,
          repoId: session.repoId,
          repoFullName: session.repoFullName,
          issueNumber: session.issueNumber,
          sourceSha: session.sourceSha,
          action: input.action,
          mutationIntentDigest: input.mutationIntentDigest.toLowerCase(),
          expectedHeadRef,
          expectedPullRequestMarker,
          bindingDigest,
          requestId: input.idempotencyKey,
          expiresAt,
          consumedAt: now,
        },
      });
      const execution = await tx.agentMutationExecution.create({
        data: {
          grantId: grant.id,
          runId: run.id,
          sessionId: session.id,
          generation: session.generation,
          action: input.action,
          adapterPrincipalId: input.adapterPrincipalId,
          adapterRuntimeIdentity: input.adapterRuntimeIdentity,
          bindingDigest,
          status: "CONSUMED",
          startedAt: now,
        },
      });
      await tx.agentRunEvent.create({
        data: {
          runId: run.id,
          type: "mutation_grant_consumed",
          generation: session.generation,
          actor: input.adapterPrincipalId,
          payload: {
            sessionId: session.id,
            executionId: execution.id,
            action: input.action,
            mutationIntentDigest: input.mutationIntentDigest.toLowerCase(),
            adapterRuntimeIdentity: input.adapterRuntimeIdentity,
            observationId: observation.id,
            bindingDigest,
            grantIssuedAt: now.toISOString(),
            grantConsumedAt: now.toISOString(),
          },
        },
      });
      return publicAuthorization({ ...grant, execution }, false);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && ["P2002", "P2034"].includes(error.code)
      && (input.retryAttempt ?? 0) < 2
    ) return authorizeGithubReadyPrMutation({ ...input, now, retryAttempt: (input.retryAttempt ?? 0) + 1 });
    throw error;
  }
}

type GithubMutationTargetPullRequest = NonNullable<AgentGithubObservation["mutationTarget"]>["pullRequests"][number];

export function githubMutationReadbackDisposition(input: {
  observation: AgentGithubObservation;
  grant: {
    repoId: bigint;
    repoFullName: string;
    issueNumber: number | null;
    sourceSha: string;
    expectedHeadRef: string;
    expectedPullRequestMarker: string;
    observation: { defaultBranchRef: string; githubInstallationId: string };
  };
}): {
  status: "VERIFIED" | "NOT_APPLIED" | "RESULT_UNKNOWN";
  pullRequest: GithubMutationTargetPullRequest | null;
} {
  const { observation, grant } = input;
  const target = observation.mutationTarget;
  if (
    !target
    || observation.githubInstallationId !== grant.observation.githubInstallationId
    || observation.repoId !== grant.repoId.toString()
    || observation.repoFullName.toLowerCase() !== grant.repoFullName.toLowerCase()
    || observation.defaultBranchRef !== grant.observation.defaultBranchRef
    || (observation.issue?.number ?? null) !== grant.issueNumber
    || target.expectedHeadRef !== grant.expectedHeadRef
    || target.expectedMarker !== grant.expectedPullRequestMarker
  ) return { status: "RESULT_UNKNOWN", pullRequest: null };
  if (
    target.headState === "ABSENT"
    && target.pullRequests.length === 0
    && observation.openAutopilotPullRequests.length === 0
  ) return { status: "NOT_APPLIED", pullRequest: null };
  if (target.pullRequests.length !== 1) return { status: "RESULT_UNKNOWN", pullRequest: null };
  const pullRequest = target.pullRequests[0];
  const openPullRequest = observation.openAutopilotPullRequests[0];
  const expectedOpenPullRequests = pullRequest.state === "OPEN" ? 1 : 0;
  if (
    pullRequest.state !== "OPEN"
    || pullRequest.draft
    || pullRequest.headRef !== grant.expectedHeadRef
    || pullRequest.baseRef !== grant.observation.defaultBranchRef
    || pullRequest.baseSha.toLowerCase() !== grant.sourceSha.toLowerCase()
    || observation.defaultBranchSha.toLowerCase() !== grant.sourceSha.toLowerCase()
    || pullRequest.marker !== grant.expectedPullRequestMarker
    || pullRequest.closesIssueNumber !== grant.issueNumber
    || !githubIssueEligible(observation.issue)
    || observation.openAutopilotPullRequests.length !== expectedOpenPullRequests
    || openPullRequest?.number !== pullRequest.number
    || openPullRequest?.nodeId !== pullRequest.nodeId
    || openPullRequest?.url !== pullRequest.url
    || openPullRequest?.headRef !== pullRequest.headRef
    || openPullRequest?.headSha.toLowerCase() !== pullRequest.headSha.toLowerCase()
    || openPullRequest?.baseRef !== pullRequest.baseRef
    || openPullRequest?.baseSha.toLowerCase() !== pullRequest.baseSha.toLowerCase()
    || openPullRequest?.marker !== pullRequest.marker
    || openPullRequest?.closesIssueNumber !== pullRequest.closesIssueNumber
    || (pullRequest.state === "OPEN" && target.headState !== "PRESENT")
    || (target.headState === "PRESENT" && target.headSha?.toLowerCase() !== pullRequest.headSha.toLowerCase())
  ) return { status: "RESULT_UNKNOWN", pullRequest: null };
  return { status: "VERIFIED", pullRequest };
}

export function mutationReadbackTransitionError(input: {
  currentStatus: string;
  nextStatus: "VERIFIED" | "NOT_APPLIED" | "RESULT_UNKNOWN";
  currentPullRequestNumber: number | null;
  nextPullRequestNumber: number | null;
}): string | null {
  if (input.currentStatus === "VERIFIED") {
    return input.nextStatus === "VERIFIED"
      && input.currentPullRequestNumber === input.nextPullRequestNumber
      ? null
      : "MUTATION_READBACK_TERMINAL_CONFLICT";
  }
  if (input.currentStatus === "NOT_APPLIED") {
    return input.nextStatus === "NOT_APPLIED"
      ? null
      : "MUTATION_READBACK_TERMINAL_CONFLICT";
  }
  if (!["CONSUMED", "RESULT_UNKNOWN"].includes(input.currentStatus)) {
    return "MUTATION_READBACK_STATE_INVALID";
  }
  return null;
}

export function mutationReadbackTerminalEvidenceError(input: {
  current: {
    status: string;
    pullRequestNumber: number | null;
    pullRequestNodeId: string | null;
    pullRequestUrl: string | null;
    pullRequestHeadRef: string | null;
    pullRequestHeadSha: string | null;
    pullRequestBaseSha: string | null;
    pullRequestMarker: string | null;
    closesClaimedIssue: boolean | null;
  };
  nextStatus: "VERIFIED" | "NOT_APPLIED" | "RESULT_UNKNOWN";
  nextPullRequest: GithubMutationTargetPullRequest | null;
}): string | null {
  if (input.current.status === "NOT_APPLIED") {
    return input.nextStatus === "NOT_APPLIED" && input.nextPullRequest === null
      ? null
      : "MUTATION_READBACK_TERMINAL_CONFLICT";
  }
  if (input.current.status !== "VERIFIED") return null;
  const next = input.nextPullRequest;
  if (input.nextStatus !== "VERIFIED" || !next) return "MUTATION_READBACK_TERMINAL_CONFLICT";
  return input.current.pullRequestNumber === next.number
    && input.current.pullRequestNodeId === next.nodeId
    && input.current.pullRequestUrl === next.url
    && input.current.pullRequestHeadRef === next.headRef
    && input.current.pullRequestHeadSha === next.headSha.toLowerCase()
    && input.current.pullRequestBaseSha === next.baseSha.toLowerCase()
    && input.current.pullRequestMarker === next.marker
    && input.current.closesClaimedIssue === true
    ? null
    : "MUTATION_READBACK_TERMINAL_EVIDENCE_MISMATCH";
}

export async function recordGithubMutationReadback(input: {
  executionId: string;
  workerPrincipalId: string;
  workerRuntimeBindingDigest: string;
  observation: AgentGithubObservation;
  adapterPrincipalId: string;
  adapterRuntimeIdentity: string;
  idempotencyKey: string;
  now?: Date;
  retryAttempt?: number;
}) {
  const now = input.now ?? new Date();
  const resultDigest = readbackRequestDigest(input);
  const replay = await prisma.agentMutationReadback.findUnique({
    where: { requestId: input.idempotencyKey },
    include: { execution: true },
  });
  if (replay) {
    if (
      replay.executionId !== input.executionId
      || replay.adapterPrincipalId !== input.adapterPrincipalId
      || replay.adapterRuntimeIdentity !== input.adapterRuntimeIdentity
      || replay.resultDigest !== resultDigest
    ) throw new ControlPlaneError("idempotency key가 다른 mutation readback에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    return { execution: replay.execution, readback: replay, duplicate: true };
  }
  assertFreshObservation(input.observation, now);
  try {
    return await prisma.$transaction(async (tx) => {
      const execution = await tx.agentMutationExecution.findUnique({
        where: { id: input.executionId },
        include: { grant: { include: { observation: true, session: true } } },
      });
      if (!execution) throw new ControlPlaneError("mutation execution을 찾을 수 없습니다.", 404, "MUTATION_EXECUTION_NOT_FOUND");
      if (
        execution.grant.principalId !== input.workerPrincipalId
        || execution.grant.session.principalId !== input.workerPrincipalId
        || execution.grant.session.runtimeBindingDigest !== input.workerRuntimeBindingDigest
        || execution.grant.session.runId !== execution.runId
        || execution.grant.session.generation !== execution.generation
        || execution.grant.session.repoId !== execution.grant.repoId
        || execution.grant.session.repoFullName.toLowerCase() !== execution.grant.repoFullName.toLowerCase()
        || execution.grant.session.issueNumber !== execution.grant.issueNumber
        || execution.grant.session.sourceSha.toLowerCase() !== execution.grant.sourceSha.toLowerCase()
        || execution.adapterPrincipalId !== input.adapterPrincipalId
        || execution.grant.adapterPrincipalId !== input.adapterPrincipalId
        || execution.adapterRuntimeIdentity !== input.adapterRuntimeIdentity
        || execution.grant.adapterRuntimeIdentity !== input.adapterRuntimeIdentity
        || execution.grant.revokedAt
      ) throw new ControlPlaneError("mutation execution adapter binding이 다릅니다.", 409, "MUTATION_ADAPTER_MISMATCH");
      const disposition = githubMutationReadbackDisposition({ observation: input.observation, grant: execution.grant });
      const { status, pullRequest } = disposition;
      const transitionError = mutationReadbackTransitionError({
        currentStatus: execution.status,
        nextStatus: status,
        currentPullRequestNumber: execution.pullRequestNumber,
        nextPullRequestNumber: pullRequest?.number ?? null,
      });
      if (transitionError) {
        throw new ControlPlaneError("terminal mutation readback을 모순된 observation으로 변경할 수 없습니다.", 409, transitionError);
      }
      const terminalEvidenceError = mutationReadbackTerminalEvidenceError({
        current: execution,
        nextStatus: status,
        nextPullRequest: pullRequest,
      });
      if (terminalEvidenceError) {
        throw new ControlPlaneError(
          "terminal mutation readback의 확정 evidence를 변경할 수 없습니다.",
          409,
          terminalEvidenceError,
        );
      }
      const observation = await tx.agentGithubObservation.create({
        data: {
          sessionId: execution.grant.sessionId,
          phase: "POST_MUTATION",
          adapterPrincipalId: input.adapterPrincipalId,
          adapterRuntimeIdentity: input.adapterRuntimeIdentity,
          githubInstallationId: input.observation.githubInstallationId,
          providerSnapshotId: input.observation.providerSnapshotId,
          pageCount: input.observation.pageCount,
          repoId: execution.grant.repoId,
          repoFullName: execution.grant.repoFullName,
          defaultBranchRef: input.observation.defaultBranchRef,
          defaultBranchSha: input.observation.defaultBranchSha.toLowerCase(),
          issueNumber: input.observation.issue?.number ?? null,
          issueNodeId: input.observation.issue?.nodeId ?? null,
          issueState: input.observation.issue?.state ?? null,
          issueLabels: input.observation.issue?.labels ?? Prisma.JsonNull,
          issueUpdatedAt: input.observation.issue?.updatedAt ?? null,
          openAutopilotPullRequests: input.observation.openAutopilotPullRequests as Prisma.InputJsonValue,
          mutationTarget: input.observation.mutationTarget as Prisma.InputJsonValue,
          payloadDigest: jsonDigest(observationJson(input.observation)),
          observedAt: input.observation.observedAt,
        },
      });
      const terminalReplay = execution.status === "VERIFIED" || execution.status === "NOT_APPLIED";
      const updated = terminalReplay
        ? execution
        : await tx.agentMutationExecution.update({
          where: { id: execution.id },
          data: {
            status,
            readbackObservationId: observation.id,
            pullRequestNumber: pullRequest?.number ?? null,
            pullRequestNodeId: pullRequest?.nodeId ?? null,
            pullRequestUrl: pullRequest?.url ?? null,
            pullRequestHeadRef: pullRequest?.headRef ?? null,
            pullRequestHeadSha: pullRequest?.headSha.toLowerCase() ?? null,
            pullRequestBaseSha: pullRequest?.baseSha.toLowerCase() ?? null,
            pullRequestMarker: pullRequest?.marker ?? null,
            closesClaimedIssue: pullRequest ? pullRequest.closesIssueNumber === execution.grant.issueNumber : null,
            resultDigest,
            verifiedAt: status === "RESULT_UNKNOWN" ? null : now,
          },
        });
      const readback = await tx.agentMutationReadback.create({
        data: {
          executionId: execution.id,
          observationId: observation.id,
          adapterPrincipalId: input.adapterPrincipalId,
          adapterRuntimeIdentity: input.adapterRuntimeIdentity,
          status,
          resultDigest,
          requestId: input.idempotencyKey,
        },
      });
      await tx.agentRunEvent.create({
        data: {
          runId: execution.runId,
          type: status === "VERIFIED"
            ? "mutation_readback_verified"
            : status === "NOT_APPLIED"
              ? "mutation_readback_not_applied"
              : "mutation_readback_unknown",
          generation: execution.generation,
          actor: input.adapterPrincipalId,
          payload: {
            executionId: execution.id,
            observationId: observation.id,
            adapterRuntimeIdentity: input.adapterRuntimeIdentity,
            status,
            ...(pullRequest ? {
              pullRequestNumber: pullRequest.number,
              pullRequestUrl: pullRequest.url,
              headSha: pullRequest.headSha.toLowerCase(),
            } : {}),
          },
        },
      });
      return { execution: updated, readback, duplicate: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && ["P2002", "P2034"].includes(error.code)
      && (input.retryAttempt ?? 0) < 2
    ) return recordGithubMutationReadback({ ...input, now, retryAttempt: (input.retryAttempt ?? 0) + 1 });
    throw error;
  }
}

export async function trustedMutationDisposition(
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    sessionId: string;
    currentGeneration: number;
    readbackResolution: boolean;
    result: Record<string, unknown>;
  },
): Promise<{ mutationStarted: boolean; error: string | null }> {
  const executions = await tx.agentMutationExecution.findMany({
    where: {
      runId: input.runId,
      ...(input.readbackResolution ? { generation: { lte: input.currentGeneration } } : { sessionId: input.sessionId }),
    },
    include: { grant: true },
    orderBy: { createdAt: "desc" },
  });
  const mutationStarted = executions.some((execution) => execution.status !== "NOT_APPLIED");
  const unresolvedMutation = executions.some((execution) => (
    execution.status !== "VERIFIED" && execution.status !== "NOT_APPLIED"
  ));
  const verifiedMutation = executions.some((execution) => execution.status === "VERIFIED");
  const outcomeCode = String(input.result.outcomeCode ?? "");
  const executionId = typeof input.result.mutationExecutionId === "string"
    ? input.result.mutationExecutionId
    : null;
  if (outcomeCode === "PR_READY") {
    if (!executionId) return { mutationStarted, error: "TRUSTED_MUTATION_EVIDENCE_REQUIRED" };
    const execution = executions.find((candidate) => candidate.id === executionId);
    if (
      !execution
      || execution.status !== "VERIFIED"
      || execution.pullRequestNumber !== input.result.pullRequestNumber
      || execution.pullRequestUrl !== input.result.pullRequestUrl
      || (input.result.commitSha && execution.pullRequestHeadSha !== String(input.result.commitSha).toLowerCase())
    ) return { mutationStarted, error: "TRUSTED_MUTATION_RESULT_MISMATCH" };
    return { mutationStarted: true, error: null };
  }
  if ((unresolvedMutation || verifiedMutation) && outcomeCode !== "RESULT_UNKNOWN") {
    return { mutationStarted: true, error: "TRUSTED_MUTATION_READBACK_REQUIRED" };
  }
  if (executionId && !executions.some((candidate) => candidate.id === executionId)) {
    return { mutationStarted, error: "TRUSTED_MUTATION_RESULT_MISMATCH" };
  }
  return { mutationStarted, error: null };
}
