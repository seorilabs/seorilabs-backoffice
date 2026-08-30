import { Prisma } from "@prisma/client";

import {
  agentExecutionPolicy,
  agentRepositorySingletonScope,
  parseManagedWorkerPolicy,
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
} from "@/lib/control-plane/automation-catalog";
import type {
  AgentGithubMutationStepKind,
  AgentGithubMutationStepObservation,
  AgentGithubObservation,
} from "@/lib/control-plane/contracts";
import { githubInstallationProviderPayloadSchema } from "@/lib/control-plane/github-installation-observation";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { repositoryAutomationEligible } from "@/lib/control-plane/repository-registration";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";
import { workflowBundleCandidateTaskSchema } from "@/lib/control-plane/workflow-bundle-candidate-contract";

export const GITHUB_READY_PR_MUTATION_ACTION = "GITHUB_READY_PR_MUTATE" as const;
const OBSERVATION_MAX_AGE_MS = 60_000;
const OBSERVATION_FUTURE_SKEW_MS = 5_000;
const GRANT_TTL_MS = 5 * 60_000;
const STEP_ATTEMPT_TTL_MS = 60_000;

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
  expectedTarget?: { headRef: string; marker: string };
}): string {
  return jsonDigest({
    sessionId: input.sessionId,
    workerPrincipalId: input.workerPrincipalId,
    workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
    action: input.action,
    mutationIntentDigest: input.mutationIntentDigest.toLowerCase(),
    adapterPrincipalId: input.adapterPrincipalId,
    adapterRuntimeIdentity: input.adapterRuntimeIdentity,
    ...(input.expectedTarget ? { expectedTarget: input.expectedTarget } : {}),
    observation: observationJson(input.observation),
  });
}

export function resolveGithubMutationTarget(input: {
  definition: { template: string; agentKind: string | null };
  taskInput: Prisma.JsonValue | null;
  session: { repoId: bigint; repoFullName: string; issueNumber: number | null; sourceSha: string };
  workerPrincipalId: string;
  mutationIntentDigest: string;
  requested?: { headRef: string; marker: string };
  generated: { headRef: string; marker: string };
}): { headRef: string; marker: string } {
  const candidateDefinition = input.definition.template === WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY;
  if (!candidateDefinition) {
    if (input.requested) {
      throw new ControlPlaneError(
        "일반 READY_PR definition은 custom mutation target을 사용할 수 없습니다.",
        409,
        "CUSTOM_MUTATION_TARGET_FORBIDDEN",
      );
    }
    return input.generated;
  }
  if (
    input.definition.agentKind !== null
    || input.workerPrincipalId !== WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL
    || !input.requested
  ) {
    throw new ControlPlaneError(
      "WorkflowBundle candidate executor identity 또는 target이 일치하지 않습니다.",
      409,
      "WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_BINDING_MISMATCH",
    );
  }
  const task = workflowBundleCandidateTaskSchema.safeParse(input.taskInput);
  if (
    !task.success
    || task.data.repository.id !== input.session.repoId.toString()
    || task.data.repository.fullName.toLowerCase() !== input.session.repoFullName.toLowerCase()
    || task.data.repository.issueNumber !== input.session.issueNumber
    || task.data.repository.sourceSha !== input.session.sourceSha.toLowerCase()
    || task.data.mutation.intentDigest !== input.mutationIntentDigest.toLowerCase()
    || task.data.github.expectedHeadRef !== input.requested.headRef
    || task.data.github.expectedPullRequestMarker !== input.requested.marker
  ) {
    throw new ControlPlaneError(
      "WorkflowBundle candidate task와 JIT mutation target이 일치하지 않습니다.",
      409,
      "WORKFLOW_BUNDLE_CANDIDATE_TASK_BINDING_MISMATCH",
    );
  }
  return input.requested;
}

function readbackRequestDigest(input: {
  sessionId: string;
  executionId: string;
  workerPrincipalId: string;
  workerRuntimeBindingDigest: string;
  adapterPrincipalId: string;
  adapterRuntimeIdentity: string;
  observation: AgentGithubObservation;
}): string {
  return jsonDigest({
    sessionId: input.sessionId,
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

function assertMutationAuthorizationReplayObservation(input: {
  observation: AgentGithubObservation;
  grant: {
    repoId: bigint;
    repoFullName: string;
    issueNumber: number | null;
    sourceSha: string;
    expectedHeadRef: string;
    expectedPullRequestMarker: string;
    observation: {
      githubInstallationId: string;
      defaultBranchRef: string;
    };
  };
}): void {
  const { observation, grant } = input;
  if (
    observation.githubInstallationId !== grant.observation.githubInstallationId
    || observation.repoId !== grant.repoId.toString()
    || observation.repoFullName.toLowerCase() !== grant.repoFullName.toLowerCase()
    || observation.defaultBranchRef !== grant.observation.defaultBranchRef
    || observation.defaultBranchSha.toLowerCase() !== grant.sourceSha.toLowerCase()
    || (observation.issue?.number ?? null) !== grant.issueNumber
    || (grant.issueNumber !== null && !githubIssueEligible(observation.issue))
    || observation.mutationTarget !== null
  ) {
    throw new ControlPlaneError(
      "mutation authorization replay의 repository/source/issue binding이 다릅니다.",
      409,
      "GITHUB_MUTATION_REPLAY_OBSERVATION_MISMATCH",
    );
  }
  if (observation.openAutopilotPullRequests.length === 0) return;
  if (observation.openAutopilotPullRequests.length !== 1) {
    throw new ControlPlaneError(
      "mutation authorization replay에서 다른 READY PR을 발견했습니다.",
      409,
      "GITHUB_MUTATION_REPLAY_SINGLETON_MISMATCH",
    );
  }
  const pullRequest = observation.openAutopilotPullRequests[0];
  if (
    pullRequest.state !== "OPEN"
    || pullRequest.draft
    || pullRequest.headRef !== grant.expectedHeadRef
    || pullRequest.baseRef !== grant.observation.defaultBranchRef
    || pullRequest.baseSha.toLowerCase() !== grant.sourceSha.toLowerCase()
    || pullRequest.marker !== grant.expectedPullRequestMarker
    || pullRequest.closesIssueNumber !== grant.issueNumber
  ) {
    throw new ControlPlaneError(
      "mutation authorization replay의 기존 READY PR이 grant와 일치하지 않습니다.",
      409,
      "GITHUB_MUTATION_REPLAY_TARGET_MISMATCH",
    );
  }
}

function publicAuthorization(grant: {
  action: string;
  mutationIntentDigest: string;
  expectedHeadRef: string;
  expectedPullRequestMarker: string;
  expiresAt: Date;
  execution: { id: string; status: string; startedAt: Date } | null;
}, duplicate: boolean) {
  if (!grant.execution) throw new ControlPlaneError("consumed grant execution을 찾을 수 없습니다.", 409, "MUTATION_EXECUTION_MISSING");
  return {
    executionId: grant.execution.id,
    action: grant.action,
    mutationIntentDigest: grant.mutationIntentDigest,
    expectedHeadRef: grant.expectedHeadRef,
    expectedPullRequestMarker: grant.expectedPullRequestMarker,
    expiresAt: grant.expiresAt,
    commitDate: grant.execution.startedAt,
    status: grant.execution.status,
    writeDisposition: "STEP_LEDGER" as const,
    duplicate,
  };
}

function publicResumedAuthorization(input: {
  execution: MutationStepExecution;
  expiresAt: Date;
  duplicate: boolean;
}) {
  return {
    executionId: input.execution.id,
    action: GITHUB_READY_PR_MUTATION_ACTION,
    mutationIntentDigest: input.execution.grant.mutationIntentDigest,
    expectedHeadRef: input.execution.grant.expectedHeadRef,
    expectedPullRequestMarker: input.execution.grant.expectedPullRequestMarker,
    expiresAt: input.expiresAt,
    commitDate: input.execution.startedAt,
    status: input.execution.status,
    writeDisposition: "STEP_LEDGER" as const,
    duplicate: input.duplicate,
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
  expectedTarget?: { headRef: string; marker: string };
  now?: Date;
  retryAttempt?: number;
}) {
  const now = input.now ?? new Date();
  const bindingDigest = mutationRequestDigest(input);
  const replay = await prisma.agentActionGrant.findUnique({
    where: { requestId: input.idempotencyKey },
    include: {
      execution: true,
      observation: true,
      session: { include: { lease: { include: { run: true } } } },
    },
  });
  if (replay) {
    if (
      replay.sessionId !== input.sessionId
      || replay.action !== input.action
      || replay.principalId !== input.workerPrincipalId
      || replay.session.runtimeBindingDigest !== input.workerRuntimeBindingDigest
      || replay.adapterPrincipalId !== input.adapterPrincipalId
      || replay.adapterRuntimeIdentity !== input.adapterRuntimeIdentity
      || replay.mutationIntentDigest !== input.mutationIntentDigest.toLowerCase()
      || (input.expectedTarget !== undefined && (
        replay.expectedHeadRef !== input.expectedTarget.headRef
        || replay.expectedPullRequestMarker !== input.expectedTarget.marker
      ))
    ) {
      throw new ControlPlaneError("idempotency key가 다른 mutation authorization에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    assertSessionState(replay.session, input.workerPrincipalId, input.workerRuntimeBindingDigest, now);
    if (replay.revokedAt || replay.expiresAt <= now) {
      throw new ControlPlaneError("mutation authorization replay가 만료되었습니다.", 409, "STALE_MUTATION_GRANT");
    }
    assertFreshObservation(input.observation, now);
    assertMutationAuthorizationReplayObservation({ observation: input.observation, grant: replay });
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
      const target = resolveGithubMutationTarget({
        definition: run.occurrence.definition,
        taskInput: run.taskInput,
        session,
        workerPrincipalId: input.workerPrincipalId,
        mutationIntentDigest: input.mutationIntentDigest,
        requested: input.expectedTarget,
        generated: {
          headRef: `refs/heads/seori/run-${run.id.slice(0, 20)}-${session.generation}`,
          marker: `seori-run:${run.id}:${session.generation}`,
        },
      });
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
      const resumableExecutions = await tx.agentMutationExecution.findMany({
        where: {
          runId: run.id,
          generation: { lt: session.generation },
          status: { in: ["CONSUMED", "IN_PROGRESS", "RESULT_UNKNOWN"] },
        },
        include: mutationStepExecutionInclude,
        orderBy: [{ generation: "desc" }, { createdAt: "desc" }],
        take: 2,
      });
      const resumable = resumableExecutions[0];
      if (resumable) {
        if (
          resumableExecutions[1]?.generation === resumable.generation
          || resumable.action !== input.action
          || resumable.grant.principalId !== input.workerPrincipalId
          || resumable.grant.adapterPrincipalId !== input.adapterPrincipalId
          || resumable.grant.revokedAt
          || resumable.grant.repoId !== session.repoId
          || resumable.grant.repoFullName.toLowerCase() !== session.repoFullName.toLowerCase()
          || resumable.grant.issueNumber !== session.issueNumber
          || resumable.grant.sourceSha.toLowerCase() !== session.sourceSha.toLowerCase()
          || resumable.grant.mutationIntentDigest !== input.mutationIntentDigest.toLowerCase()
          || (input.expectedTarget !== undefined && (
            resumable.grant.expectedHeadRef !== target.headRef
            || resumable.grant.expectedPullRequestMarker !== target.marker
          ))
          || githubMutationStepLedgerVerified(resumable.steps)
        ) {
          throw new ControlPlaneError("기존 mutation execution의 resume binding이 다릅니다.", 409, "MUTATION_RESUME_BINDING_MISMATCH");
        }
        assertMutationAuthorizationReplayObservation({ observation: input.observation, grant: resumable.grant });
        const resumeExpiresAt = new Date(Math.min(now.getTime() + GRANT_TTL_MS, session.expiresAt.getTime()));
        if (resumeExpiresAt <= now) {
          throw new ControlPlaneError("resume authorization 전에 session이 만료되었습니다.", 409, "STALE_SESSION");
        }
        const replayEvent = await tx.agentRunEvent.findUnique({ where: { requestId: input.idempotencyKey } });
        if (replayEvent) {
          const payload = replayEvent.payload as {
            sessionId?: string;
            executionId?: string;
            bindingDigest?: string;
            adapterRuntimeIdentity?: string;
          } | null;
          if (
            replayEvent.type !== "mutation_execution_resumed"
            || replayEvent.runId !== run.id
            || replayEvent.generation !== session.generation
            || replayEvent.actor !== input.adapterPrincipalId
            || payload?.sessionId !== session.id
            || payload.executionId !== resumable.id
            || payload.bindingDigest !== bindingDigest
            || payload.adapterRuntimeIdentity !== input.adapterRuntimeIdentity
          ) throw new ControlPlaneError("idempotency key가 다른 mutation resume에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
          return publicResumedAuthorization({ execution: resumable, expiresAt: resumeExpiresAt, duplicate: true });
        }
        await tx.agentRunEvent.create({
          data: {
            requestId: input.idempotencyKey,
            runId: run.id,
            type: "mutation_execution_resumed",
            generation: session.generation,
            actor: input.adapterPrincipalId,
            payload: {
              sessionId: session.id,
              executionId: resumable.id,
              sourceExecutionGeneration: resumable.generation,
              bindingDigest,
              mutationIntentDigest: input.mutationIntentDigest.toLowerCase(),
              adapterRuntimeIdentity: input.adapterRuntimeIdentity,
              expiresAt: resumeExpiresAt.toISOString(),
            },
          },
        });
        return publicResumedAuthorization({ execution: resumable, expiresAt: resumeExpiresAt, duplicate: false });
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
      const expectedHeadRef = target.headRef;
      const expectedPullRequestMarker = target.marker;
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
          steps: {
            create: [
              { kind: "CREATE_COMMIT", ordinal: 1 },
              { kind: "CREATE_REF", ordinal: 2 },
              { kind: "CREATE_PR", ordinal: 3 },
            ],
          },
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

function publicMutationRecovery(execution: MutationStepExecution, duplicate: boolean) {
  return {
    executionId: execution.id,
    status: execution.status,
    repoId: execution.grant.repoId.toString(),
    repoFullName: execution.grant.repoFullName,
    issueNumber: execution.grant.issueNumber,
    sourceSha: execution.grant.sourceSha,
    expectedHeadRef: execution.grant.expectedHeadRef,
    expectedPullRequestMarker: execution.grant.expectedPullRequestMarker,
    duplicate,
  };
}

export async function claimGithubMutationRecovery(input: {
  sessionId: string;
  workerPrincipalId: string;
  workerRuntimeBindingDigest: string;
  adapterPrincipalId: string;
  adapterRuntimeIdentity: string;
  idempotencyKey: string;
  now?: Date;
  retryAttempt?: number;
}) {
  const now = input.now ?? new Date();
  const requestDigest = jsonDigest({
    sessionId: input.sessionId,
    workerPrincipalId: input.workerPrincipalId,
    workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
    adapterPrincipalId: input.adapterPrincipalId,
    adapterRuntimeIdentity: input.adapterRuntimeIdentity,
  });
  try {
    return await prisma.$transaction(async (tx) => {
      const session = await tx.agentWorkerSession.findUnique({
        where: { id: input.sessionId },
        include: activeMutationSessionInclude,
      });
      if (!session) throw new ControlPlaneError("agent worker session을 찾을 수 없습니다.", 404, "SESSION_NOT_FOUND");
      assertSessionState(session, input.workerPrincipalId, input.workerRuntimeBindingDigest, now);
      const run = session.lease.run;
      const policy = parseManagedWorkerPolicy(run.occurrence.definition);
      const executionPolicy = policy ? agentExecutionPolicy(policy, "READBACK_FIRST") : null;
      const singletonScope = executionPolicy
        ? agentRepositorySingletonScope(session.repoFullName, executionPolicy)
        : null;
      if (
        !run.readbackRequestedAt
        || !singletonScope
        || run.repoGuard?.activeScopeKey !== singletonScope
      ) {
        throw new ControlPlaneError("현재 session은 mutation READBACK_FIRST recovery가 아닙니다.", 409, "MUTATION_RECOVERY_SESSION_INVALID");
      }
      const executions = await tx.agentMutationExecution.findMany({
        where: {
          runId: run.id,
          generation: { lt: session.generation },
          status: { in: ["CONSUMED", "IN_PROGRESS", "RESULT_UNKNOWN", "VERIFIED"] },
        },
        include: mutationStepExecutionInclude,
        orderBy: [{ generation: "desc" }, { createdAt: "desc" }],
        take: 2,
      });
      const execution = executions[0];
      if (!execution) {
        throw new ControlPlaneError("복구할 mutation execution을 찾을 수 없습니다.", 404, "MUTATION_RECOVERY_NOT_FOUND");
      }
      if (
        executions[1]?.generation === execution.generation
        || execution.action !== GITHUB_READY_PR_MUTATION_ACTION
        || execution.grant.principalId !== input.workerPrincipalId
        || execution.grant.adapterPrincipalId !== input.adapterPrincipalId
        || execution.grant.repoId !== session.repoId
        || execution.grant.repoFullName.toLowerCase() !== session.repoFullName.toLowerCase()
        || execution.grant.issueNumber !== session.issueNumber
        || execution.grant.sourceSha.toLowerCase() !== session.sourceSha.toLowerCase()
      ) {
        throw new ControlPlaneError("mutation recovery binding이 모호하거나 다릅니다.", 409, "MUTATION_RECOVERY_BINDING_MISMATCH");
      }
      const replay = await tx.agentRunEvent.findUnique({ where: { requestId: input.idempotencyKey } });
      if (replay) {
        const payload = replay.payload as {
          sessionId?: string;
          executionId?: string;
          adapterRuntimeIdentity?: string;
          requestDigest?: string;
        } | null;
        if (
          replay.type !== "mutation_recovery_claimed"
          || replay.runId !== run.id
          || replay.generation !== session.generation
          || replay.actor !== input.adapterPrincipalId
          || payload?.sessionId !== session.id
          || payload.executionId !== execution.id
          || payload.adapterRuntimeIdentity !== input.adapterRuntimeIdentity
          || payload.requestDigest !== requestDigest
        ) throw new ControlPlaneError("idempotency key가 다른 mutation recovery에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
        return publicMutationRecovery(execution, true);
      }
      await tx.agentRunEvent.create({
        data: {
          requestId: input.idempotencyKey,
          runId: run.id,
          type: "mutation_recovery_claimed",
          generation: session.generation,
          actor: input.adapterPrincipalId,
          payload: {
            sessionId: session.id,
            executionId: execution.id,
            adapterRuntimeIdentity: input.adapterRuntimeIdentity,
            requestDigest,
            sourceExecutionGeneration: execution.generation,
          },
        },
      });
      return publicMutationRecovery(execution, false);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && ["P2002", "P2034"].includes(error.code)
      && (input.retryAttempt ?? 0) < 2
    ) return claimGithubMutationRecovery({ ...input, now, retryAttempt: (input.retryAttempt ?? 0) + 1 });
    throw error;
  }
}

function stepObservationJson(observation: AgentGithubMutationStepObservation): JsonValue {
  return {
    ...observation,
    observedAt: observation.observedAt.toISOString(),
    defaultBranchSha: observation.defaultBranchSha.toLowerCase(),
    issue: observation.issue ? {
      ...observation.issue,
      labels: normalizedLabels(observation.issue.labels),
      updatedAt: observation.issue.updatedAt.toISOString(),
    } : null,
    expectedTreeSha: observation.expectedTreeSha?.toLowerCase() ?? null,
    expectedCommitSha: observation.expectedCommitSha?.toLowerCase() ?? null,
    commit: observation.commit ? {
      sha: observation.commit.sha.toLowerCase(),
      treeSha: observation.commit.treeSha.toLowerCase(),
      parentSha: observation.commit.parentSha.toLowerCase(),
    } : null,
    headSha: observation.headSha?.toLowerCase() ?? null,
    openAutopilotPullRequests: observation.openAutopilotPullRequests.map((pullRequest) => ({
      ...pullRequest,
      headSha: pullRequest.headSha.toLowerCase(),
      baseSha: pullRequest.baseSha.toLowerCase(),
    })),
    pullRequests: observation.pullRequests.map((pullRequest) => ({
      ...pullRequest,
      headSha: pullRequest.headSha.toLowerCase(),
      baseSha: pullRequest.baseSha.toLowerCase(),
    })),
  } as JsonValue;
}

const mutationStepExecutionInclude = {
  grant: {
    include: {
      observation: true,
      session: { include: { lease: { include: { run: true } } } },
    },
  },
  steps: { orderBy: { ordinal: "asc" as const } },
} as const;

const activeMutationSessionInclude = {
  lease: {
    include: {
      run: { include: { occurrence: { include: { definition: true } }, repoGuard: true } },
    },
  },
} as const;

type MutationStepExecution = Prisma.AgentMutationExecutionGetPayload<{
  include: typeof mutationStepExecutionInclude;
}>;

type ActiveMutationSession = Prisma.AgentWorkerSessionGetPayload<{
  include: typeof activeMutationSessionInclude;
}>;

function mutationStepSessionMode(input: {
  execution: MutationStepExecution;
  session: ActiveMutationSession;
  workerPrincipalId: string;
  workerRuntimeBindingDigest: string;
  adapterPrincipalId: string;
  adapterRuntimeIdentity: string;
  now: Date;
}): "START" | "READBACK" | "RESUME_WRITE" {
  const { execution, session, now } = input;
  const { grant } = execution;
  if (
    execution.action !== GITHUB_READY_PR_MUTATION_ACTION
    || execution.runId !== grant.runId
    || execution.sessionId !== grant.sessionId
    || execution.generation !== grant.generation
    || execution.adapterPrincipalId !== grant.adapterPrincipalId
    || execution.adapterRuntimeIdentity !== grant.adapterRuntimeIdentity
    || grant.session.runId !== grant.runId
    || grant.session.generation !== grant.generation
    || grant.session.principalId !== grant.principalId
    || grant.session.repoId !== grant.repoId
    || grant.session.repoFullName.toLowerCase() !== grant.repoFullName.toLowerCase()
    || grant.session.issueNumber !== grant.issueNumber
    || grant.session.sourceSha.toLowerCase() !== grant.sourceSha.toLowerCase()
    || grant.principalId !== input.workerPrincipalId
    || grant.adapterPrincipalId !== input.adapterPrincipalId
    || grant.revokedAt
    || session.runId !== execution.runId
    || session.repoId !== grant.repoId
    || session.repoFullName.toLowerCase() !== grant.repoFullName.toLowerCase()
    || session.issueNumber !== grant.issueNumber
    || session.sourceSha.toLowerCase() !== grant.sourceSha.toLowerCase()
  ) {
    throw new ControlPlaneError("mutation step session binding이 다릅니다.", 409, "MUTATION_STEP_SESSION_MISMATCH");
  }
  assertSessionState(session, input.workerPrincipalId, input.workerRuntimeBindingDigest, now);
  if (session.id === execution.sessionId) {
    if (
      execution.adapterPrincipalId !== input.adapterPrincipalId
      || execution.adapterRuntimeIdentity !== input.adapterRuntimeIdentity
      || grant.adapterRuntimeIdentity !== input.adapterRuntimeIdentity
      || grant.session.runtimeBindingDigest !== input.workerRuntimeBindingDigest
      || grant.expiresAt <= now
    ) throw new ControlPlaneError("mutation grant가 만료되었거나 adapter binding이 다릅니다.", 409, "STALE_MUTATION_GRANT");
    return "START";
  }
  if (session.generation <= execution.generation) {
    throw new ControlPlaneError("과거 generation은 mutation execution을 복구할 수 없습니다.", 409, "STALE_MUTATION_RECOVERY_GENERATION");
  }
  const policy = parseManagedWorkerPolicy(session.lease.run.occurrence.definition);
  const resumeMode = session.lease.run.readbackRequestedAt ? "READBACK_FIRST" : "START";
  const executionPolicy = policy ? agentExecutionPolicy(policy, resumeMode) : null;
  const singletonScope = executionPolicy
    ? agentRepositorySingletonScope(session.repoFullName, executionPolicy)
    : null;
  if (!singletonScope || session.lease.run.repoGuard?.activeScopeKey !== singletonScope) {
    throw new ControlPlaneError("복구 중인 run이 repo singleton을 보유하지 않습니다.", 409, "REPO_SINGLETON_NOT_OWNED");
  }
  if (resumeMode === "READBACK_FIRST") return "READBACK";
  if (executionPolicy?.mutationAction !== GITHUB_READY_PR_MUTATION_ACTION) {
    throw new ControlPlaneError("복구 후 write action policy가 mutation을 허용하지 않습니다.", 409, "ACTION_POLICY_VIOLATION");
  }
  return "RESUME_WRITE";
}

async function assertMutationSessionAudit(input: {
  tx: Prisma.TransactionClient;
  execution: MutationStepExecution;
  session: ActiveMutationSession;
  mode: "READBACK" | "RESUME_WRITE";
  adapterPrincipalId: string;
  adapterRuntimeIdentity: string;
}): Promise<void> {
  const event = await input.tx.agentRunEvent.findFirst({
    where: {
      runId: input.execution.runId,
      generation: input.session.generation,
      type: input.mode === "READBACK" ? "mutation_recovery_claimed" : "mutation_execution_resumed",
      actor: input.adapterPrincipalId,
    },
    orderBy: { createdAt: "desc" },
  });
  const payload = event?.payload as {
    sessionId?: string;
    executionId?: string;
    adapterRuntimeIdentity?: string;
  } | null;
  if (
    payload?.sessionId !== input.session.id
    || payload.executionId !== input.execution.id
    || payload.adapterRuntimeIdentity !== input.adapterRuntimeIdentity
  ) {
    throw new ControlPlaneError("mutation recovery audit binding이 없습니다.", 409, "MUTATION_RECOVERY_NOT_CLAIMED");
  }
}

function publicStepClaim(input: {
  execution: MutationStepExecution;
  step: MutationStepExecution["steps"][number];
  attempt: {
    id: string;
    generation: number;
    expiresAt: Date;
    status: string;
  } | null;
  mode: "START" | "READBACK" | "RESUME_WRITE";
  duplicate: boolean;
}) {
  const commitStep = input.execution.steps.find((step) => step.kind === "CREATE_COMMIT");
  const expectedTreeSha = input.step.kind === "CREATE_COMMIT"
    ? input.step.expectedTreeSha
    : commitStep?.outputSha
      ? commitStep.expectedTreeSha
      : null;
  const expectedCommitSha = input.step.kind === "CREATE_COMMIT"
    ? input.step.expectedCommitSha
    : commitStep?.outputSha ?? null;
  return {
    executionId: input.execution.id,
    stepId: input.step.id,
    stepKind: input.step.kind as AgentGithubMutationStepKind,
    stepStatus: input.step.status,
    generation: input.attempt?.generation ?? input.step.generation,
    attemptId: input.attempt?.id ?? null,
    expiresAt: input.attempt?.expiresAt ?? null,
    expectedTreeSha,
    expectedCommitSha,
    expectedHeadRef: input.execution.grant.expectedHeadRef,
    expectedPullRequestMarker: input.execution.grant.expectedPullRequestMarker,
    sourceSha: input.execution.grant.sourceSha,
    commitDate: input.execution.startedAt,
    writeDisposition: input.step.status === "VERIFIED"
      ? "ALREADY_VERIFIED" as const
      : input.mode === "READBACK"
        ? "READBACK_ONLY" as const
      : input.step.status === "PLANNED" || input.step.status === "RESULT_UNKNOWN"
        ? "READBACK_THEN_EXECUTE" as const
        : "EXECUTE_ONCE" as const,
    duplicate: input.duplicate,
  };
}

export async function claimGithubMutationStep(input: {
  sessionId: string;
  executionId: string;
  workerPrincipalId: string;
  workerRuntimeBindingDigest: string;
  stepKind: AgentGithubMutationStepKind;
  adapterPrincipalId: string;
  adapterRuntimeIdentity: string;
  idempotencyKey: string;
  now?: Date;
  retryAttempt?: number;
}) {
  const now = input.now ?? new Date();
  const requestDigest = jsonDigest({
    sessionId: input.sessionId,
    executionId: input.executionId,
    workerPrincipalId: input.workerPrincipalId,
    workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
    stepKind: input.stepKind,
    adapterPrincipalId: input.adapterPrincipalId,
    adapterRuntimeIdentity: input.adapterRuntimeIdentity,
  });
  const replay = await prisma.agentMutationStepAttempt.findUnique({
    where: { requestId: input.idempotencyKey },
    include: {
      session: { include: activeMutationSessionInclude },
      step: { include: { execution: { include: mutationStepExecutionInclude } } },
    },
  });
  if (replay) {
    if (
      replay.bindingDigest !== requestDigest
      || replay.sessionId !== input.sessionId
      || replay.step.executionId !== input.executionId
      || replay.step.kind !== input.stepKind
    ) throw new ControlPlaneError("idempotency key가 다른 mutation step claim에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    const mode = mutationStepSessionMode({ execution: replay.step.execution, session: replay.session, ...input, now });
    if (replay.step.status === "VERIFIED") {
      return publicStepClaim({
        execution: replay.step.execution,
        step: replay.step,
        attempt: null,
        mode,
        duplicate: true,
      });
    }
    if (replay.step.status !== "VERIFIED" && ["VERIFIED", "NOT_APPLIED", "RESULT_UNKNOWN"].includes(replay.status)) {
      throw new ControlPlaneError(
        "terminal mutation step attempt는 새 claim으로만 재개할 수 있습니다.",
        409,
        "MUTATION_STEP_ATTEMPT_TERMINAL",
      );
    }
    if (
      replay.generation !== replay.step.generation
      || replay.expiresAt <= now
      || replay.status === "STALE"
    ) throw new ControlPlaneError("mutation step claim이 만료되었거나 대체되었습니다.", 409, "STALE_MUTATION_STEP_ATTEMPT");
    return publicStepClaim({
      execution: replay.step.execution,
      step: replay.step,
      attempt: replay,
      mode,
      duplicate: true,
    });
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const execution = await tx.agentMutationExecution.findUnique({
        where: { id: input.executionId },
        include: mutationStepExecutionInclude,
      });
      if (!execution) throw new ControlPlaneError("mutation execution을 찾을 수 없습니다.", 404, "MUTATION_EXECUTION_NOT_FOUND");
      const session = await tx.agentWorkerSession.findUnique({
        where: { id: input.sessionId },
        include: activeMutationSessionInclude,
      });
      if (!session) throw new ControlPlaneError("agent worker session을 찾을 수 없습니다.", 404, "SESSION_NOT_FOUND");
      const mode = mutationStepSessionMode({ execution, session, ...input, now });
      if (mode !== "START") {
        await assertMutationSessionAudit({
          tx,
          execution,
          session,
          mode,
          adapterPrincipalId: input.adapterPrincipalId,
          adapterRuntimeIdentity: input.adapterRuntimeIdentity,
        });
      }
      const step = execution.steps.find((candidate) => candidate.kind === input.stepKind);
      if (!step) throw new ControlPlaneError("mutation step을 찾을 수 없습니다.", 404, "MUTATION_STEP_NOT_FOUND");
      if (step.status === "VERIFIED") {
        return publicStepClaim({ execution, step, attempt: null, mode, duplicate: false });
      }
      if (["VERIFIED", "NOT_APPLIED"].includes(execution.status)) {
        throw new ControlPlaneError(
          "terminal mutation execution에는 새 step 작업을 시작할 수 없습니다.",
          409,
          "MUTATION_EXECUTION_TERMINAL",
        );
      }
      const predecessor = execution.steps.find((candidate) => candidate.ordinal === step.ordinal - 1);
      if (predecessor && (predecessor.status !== "VERIFIED" || !predecessor.outputSha)) {
        throw new ControlPlaneError("이전 mutation step이 provider readback으로 확정되지 않았습니다.", 409, "MUTATION_STEP_PREDECESSOR_UNVERIFIED");
      }
      const activeAttempt = await tx.agentMutationStepAttempt.findUnique({
        where: { stepId_generation: { stepId: step.id, generation: step.generation } },
      });
      if (activeAttempt && ["CLAIMED", "PLANNED"].includes(activeAttempt.status)) {
        if (activeAttempt.expiresAt > now) {
          throw new ControlPlaneError("mutation step을 다른 실행이 사용 중입니다.", 409, "MUTATION_STEP_ALREADY_CLAIMED");
        }
        const expired = await tx.agentMutationStepAttempt.updateMany({
          where: {
            id: activeAttempt.id,
            generation: step.generation,
            status: { in: ["CLAIMED", "PLANNED"] },
            expiresAt: { lte: now },
          },
          data: { status: "STALE", completedAt: now },
        });
        if (expired.count !== 1) {
          throw new ControlPlaneError("mutation step claim CAS가 충돌했습니다.", 409, "MUTATION_STEP_CAS_CONFLICT");
        }
      }
      const generation = step.generation + 1;
      const resumesCommitPlan = step.kind === "CREATE_COMMIT"
        && Boolean(step.expectedTreeSha && step.expectedCommitSha);
      const expiresAt = new Date(Math.min(
        now.getTime() + STEP_ATTEMPT_TTL_MS,
        session.expiresAt.getTime(),
        session.lease.expiresAt.getTime(),
        ...(mode === "START" ? [execution.grant.expiresAt.getTime()] : []),
      ));
      if (expiresAt <= now) throw new ControlPlaneError("mutation step claim 전에 TTL이 만료되었습니다.", 409, "STALE_MUTATION_STEP_ATTEMPT");
      const attempt = await tx.agentMutationStepAttempt.create({
        data: {
          stepId: step.id,
          sessionId: session.id,
          generation,
          principalId: input.workerPrincipalId,
          runtimeBindingDigest: input.workerRuntimeBindingDigest,
          adapterPrincipalId: input.adapterPrincipalId,
          adapterRuntimeIdentity: input.adapterRuntimeIdentity,
          requestId: input.idempotencyKey,
          bindingDigest: requestDigest,
          status: resumesCommitPlan ? "PLANNED" : "CLAIMED",
          expiresAt,
        },
      });
      const updatedCount = await tx.agentMutationStep.updateMany({
        where: { id: step.id, generation: step.generation, status: { not: "VERIFIED" } },
        data: {
          generation,
          status: resumesCommitPlan ? "PLANNED" : "CLAIMED",
          inputDigest: execution.grant.mutationIntentDigest,
          expectedTreeSha: step.kind === "CREATE_COMMIT" ? step.expectedTreeSha : predecessor?.expectedTreeSha,
          expectedCommitSha: step.kind === "CREATE_COMMIT" ? step.expectedCommitSha : predecessor?.outputSha,
          claimExpiresAt: expiresAt,
        },
      });
      if (updatedCount.count !== 1) {
        throw new ControlPlaneError("mutation step generation CAS가 충돌했습니다.", 409, "MUTATION_STEP_CAS_CONFLICT");
      }
      const updatedStep = await tx.agentMutationStep.findUniqueOrThrow({ where: { id: step.id } });
      await tx.agentMutationExecution.update({
        where: { id: execution.id },
        data: { status: execution.status === "RESULT_UNKNOWN" ? "RESULT_UNKNOWN" : "IN_PROGRESS" },
      });
      await tx.agentRunEvent.create({
        data: {
          runId: execution.runId,
          type: "mutation_step_claimed",
          generation: session.generation,
          actor: input.adapterPrincipalId,
          payload: {
            executionId: execution.id,
            stepId: step.id,
            stepKind: step.kind,
            stepGeneration: generation,
            attemptId: attempt.id,
            adapterRuntimeIdentity: input.adapterRuntimeIdentity,
            sessionId: session.id,
            sessionGeneration: session.generation,
            recoveryMode: mode,
            expiresAt: expiresAt.toISOString(),
          },
        },
      });
      return publicStepClaim({
        execution: { ...execution, steps: execution.steps.map((candidate) => (
          candidate.id === updatedStep.id ? updatedStep : candidate
        )) },
        step: updatedStep,
        attempt,
        mode,
        duplicate: false,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && ["P2002", "P2034"].includes(error.code)
      && (input.retryAttempt ?? 0) < 2
    ) return claimGithubMutationStep({ ...input, now, retryAttempt: (input.retryAttempt ?? 0) + 1 });
    throw error;
  }
}

export async function planGithubCommitMutationStep(input: {
  sessionId: string;
  executionId: string;
  stepId: string;
  attemptId: string;
  generation: number;
  workerPrincipalId: string;
  workerRuntimeBindingDigest: string;
  stepKind: "CREATE_COMMIT";
  expectedTreeSha: string;
  expectedCommitSha: string;
  adapterPrincipalId: string;
  adapterRuntimeIdentity: string;
  idempotencyKey: string;
  now?: Date;
  retryAttempt?: number;
}) {
  const now = input.now ?? new Date();
  const planDigest = jsonDigest({
    sessionId: input.sessionId,
    executionId: input.executionId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    generation: input.generation,
    workerPrincipalId: input.workerPrincipalId,
    workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
    stepKind: input.stepKind,
    expectedTreeSha: input.expectedTreeSha.toLowerCase(),
    expectedCommitSha: input.expectedCommitSha.toLowerCase(),
    adapterPrincipalId: input.adapterPrincipalId,
    adapterRuntimeIdentity: input.adapterRuntimeIdentity,
  });
  const replay = await prisma.agentMutationStepAttempt.findUnique({
    where: { planRequestId: input.idempotencyKey },
    include: {
      session: { include: activeMutationSessionInclude },
      step: { include: { execution: { include: mutationStepExecutionInclude } } },
    },
  });
  if (replay) {
    if (replay.id !== input.attemptId || replay.sessionId !== input.sessionId || replay.planDigest !== planDigest) {
      throw new ControlPlaneError("idempotency key가 다른 commit plan에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    const mode = mutationStepSessionMode({ execution: replay.step.execution, session: replay.session, ...input, now });
    if (mode === "READBACK") {
      throw new ControlPlaneError("READBACK_FIRST session은 commit plan을 만들 수 없습니다.", 409, "READBACK_MUTATION_FORBIDDEN");
    }
    if (replay.expiresAt <= now || replay.status !== "PLANNED") {
      throw new ControlPlaneError("commit plan attempt가 stale 상태입니다.", 409, "STALE_MUTATION_STEP_ATTEMPT");
    }
    return {
      executionId: input.executionId,
      stepId: replay.stepId,
      attemptId: replay.id,
      generation: replay.generation,
      status: replay.status,
      expectedTreeSha: input.expectedTreeSha.toLowerCase(),
      expectedCommitSha: input.expectedCommitSha.toLowerCase(),
      duplicate: true,
    };
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const attempt = await tx.agentMutationStepAttempt.findUnique({
        where: { id: input.attemptId },
        include: {
          step: { include: { execution: { include: mutationStepExecutionInclude } } },
          session: { include: activeMutationSessionInclude },
        },
      });
      if (!attempt || attempt.stepId !== input.stepId || attempt.step.executionId !== input.executionId) {
        throw new ControlPlaneError("commit plan attempt를 찾을 수 없습니다.", 404, "MUTATION_STEP_ATTEMPT_NOT_FOUND");
      }
      const execution = attempt.step.execution;
      const mode = mutationStepSessionMode({ execution, session: attempt.session, ...input, now });
      if (mode === "READBACK") {
        throw new ControlPlaneError("READBACK_FIRST session은 commit plan을 만들 수 없습니다.", 409, "READBACK_MUTATION_FORBIDDEN");
      }
      if (
        attempt.step.kind !== "CREATE_COMMIT"
        || attempt.generation !== input.generation
        || attempt.step.generation !== input.generation
        || attempt.sessionId !== input.sessionId
        || attempt.principalId !== input.workerPrincipalId
        || attempt.runtimeBindingDigest !== input.workerRuntimeBindingDigest
        || attempt.adapterPrincipalId !== input.adapterPrincipalId
        || attempt.adapterRuntimeIdentity !== input.adapterRuntimeIdentity
        || attempt.expiresAt <= now
        || attempt.step.claimExpiresAt === null
        || attempt.step.claimExpiresAt <= now
        || attempt.status !== "CLAIMED"
        || attempt.step.status !== "CLAIMED"
      ) throw new ControlPlaneError("commit plan attempt가 stale 상태입니다.", 409, "STALE_MUTATION_STEP_ATTEMPT");
      const attemptUpdate = await tx.agentMutationStepAttempt.updateMany({
        where: { id: attempt.id, generation: input.generation, status: "CLAIMED", expiresAt: { gt: now } },
        data: {
          status: "PLANNED",
          planRequestId: input.idempotencyKey,
          planDigest,
        },
      });
      const stepUpdate = await tx.agentMutationStep.updateMany({
        where: { id: input.stepId, generation: input.generation, status: "CLAIMED", claimExpiresAt: { gt: now } },
        data: {
          status: "PLANNED",
          expectedTreeSha: input.expectedTreeSha.toLowerCase(),
          expectedCommitSha: input.expectedCommitSha.toLowerCase(),
        },
      });
      if (attemptUpdate.count !== 1 || stepUpdate.count !== 1) {
        throw new ControlPlaneError("commit plan generation CAS가 충돌했습니다.", 409, "MUTATION_STEP_CAS_CONFLICT");
      }
      await tx.agentRunEvent.create({
        data: {
          runId: execution.runId,
          type: "mutation_step_planned",
          generation: attempt.session.generation,
          actor: input.adapterPrincipalId,
          payload: {
            executionId: execution.id,
            stepId: input.stepId,
            stepKind: input.stepKind,
            stepGeneration: input.generation,
            attemptId: input.attemptId,
            expectedTreeSha: input.expectedTreeSha.toLowerCase(),
            expectedCommitSha: input.expectedCommitSha.toLowerCase(),
          },
        },
      });
      return {
        executionId: execution.id,
        stepId: input.stepId,
        attemptId: input.attemptId,
        generation: input.generation,
        status: "PLANNED" as const,
        expectedTreeSha: input.expectedTreeSha.toLowerCase(),
        expectedCommitSha: input.expectedCommitSha.toLowerCase(),
        duplicate: false,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && ["P2002", "P2034"].includes(error.code)
      && (input.retryAttempt ?? 0) < 2
    ) return planGithubCommitMutationStep({ ...input, now, retryAttempt: (input.retryAttempt ?? 0) + 1 });
    throw error;
  }
}

export function githubMutationStepDisposition(input: {
  stepKind: AgentGithubMutationStepKind;
  observation: AgentGithubMutationStepObservation;
  grant: {
    repoId: bigint;
    repoFullName: string;
    issueNumber: number | null;
    sourceSha: string;
    expectedHeadRef: string;
    expectedPullRequestMarker: string;
    observation: { defaultBranchRef: string; githubInstallationId: string };
  };
  expectedTreeSha: string | null;
  expectedCommitSha: string | null;
}): {
  status: "VERIFIED" | "NOT_APPLIED" | "RESULT_UNKNOWN";
  outputSha: string | null;
  pullRequest: GithubMutationTargetPullRequest | null;
} {
  const { observation, grant } = input;
  if (
    observation.stepKind !== input.stepKind
    || observation.githubInstallationId !== grant.observation.githubInstallationId
    || observation.repoId !== grant.repoId.toString()
    || observation.repoFullName.toLowerCase() !== grant.repoFullName.toLowerCase()
    || observation.defaultBranchRef !== grant.observation.defaultBranchRef
    || observation.defaultBranchSha.toLowerCase() !== grant.sourceSha.toLowerCase()
    || (observation.issue?.number ?? null) !== grant.issueNumber
    || observation.expectedHeadRef !== grant.expectedHeadRef
    || observation.expectedPullRequestMarker !== grant.expectedPullRequestMarker
    || observation.expectedTreeSha?.toLowerCase() !== input.expectedTreeSha?.toLowerCase()
    || observation.expectedCommitSha?.toLowerCase() !== input.expectedCommitSha?.toLowerCase()
    || (grant.issueNumber !== null && !githubIssueEligible(observation.issue))
  ) return { status: "RESULT_UNKNOWN", outputSha: null, pullRequest: null };
  if (!input.expectedTreeSha || !input.expectedCommitSha) {
    return { status: "RESULT_UNKNOWN", outputSha: null, pullRequest: null };
  }
  const exactCommit = observation.commit
    && observation.commit.sha.toLowerCase() === input.expectedCommitSha.toLowerCase()
    && observation.commit.treeSha.toLowerCase() === input.expectedTreeSha.toLowerCase()
    && observation.commit.parentSha.toLowerCase() === grant.sourceSha.toLowerCase();
  if (input.stepKind === "CREATE_COMMIT") {
    if (
      observation.headSha !== null
      || observation.openAutopilotPullRequests.length !== 0
      || observation.pullRequests.length !== 0
    ) {
      return { status: "RESULT_UNKNOWN", outputSha: null, pullRequest: null };
    }
    return exactCommit
      ? { status: "VERIFIED", outputSha: observation.commit!.sha.toLowerCase(), pullRequest: null }
      : observation.commit === null
        ? { status: "NOT_APPLIED", outputSha: null, pullRequest: null }
        : { status: "RESULT_UNKNOWN", outputSha: null, pullRequest: null };
  }
  if (!exactCommit || observation.pullRequests.length > (input.stepKind === "CREATE_PR" ? 1 : 0)) {
    return { status: "RESULT_UNKNOWN", outputSha: null, pullRequest: null };
  }
  if (input.stepKind === "CREATE_REF") {
    if (observation.openAutopilotPullRequests.length !== 0 || observation.pullRequests.length !== 0) {
      return { status: "RESULT_UNKNOWN", outputSha: null, pullRequest: null };
    }
    return observation.headSha === null
      ? { status: "NOT_APPLIED", outputSha: null, pullRequest: null }
      : observation.headSha.toLowerCase() === input.expectedCommitSha.toLowerCase()
        ? { status: "VERIFIED", outputSha: observation.headSha.toLowerCase(), pullRequest: null }
        : { status: "RESULT_UNKNOWN", outputSha: null, pullRequest: null };
  }
  if (observation.headSha?.toLowerCase() !== input.expectedCommitSha.toLowerCase()) {
    return { status: "RESULT_UNKNOWN", outputSha: null, pullRequest: null };
  }
  if (observation.pullRequests.length === 0) {
    return { status: "NOT_APPLIED", outputSha: null, pullRequest: null };
  }
  const pullRequest = observation.pullRequests[0];
  const openPullRequest = observation.openAutopilotPullRequests[0];
  if (
    pullRequest.state !== "OPEN"
    || pullRequest.draft
    || pullRequest.headRef !== grant.expectedHeadRef
    || pullRequest.headSha.toLowerCase() !== input.expectedCommitSha.toLowerCase()
    || pullRequest.baseRef !== grant.observation.defaultBranchRef
    || pullRequest.baseSha.toLowerCase() !== grant.sourceSha.toLowerCase()
    || pullRequest.marker !== grant.expectedPullRequestMarker
    || pullRequest.closesIssueNumber !== grant.issueNumber
    || observation.openAutopilotPullRequests.length !== 1
    || openPullRequest?.number !== pullRequest.number
    || openPullRequest?.nodeId !== pullRequest.nodeId
    || openPullRequest?.url !== pullRequest.url
    || openPullRequest?.headRef !== pullRequest.headRef
    || openPullRequest?.headSha.toLowerCase() !== pullRequest.headSha.toLowerCase()
    || openPullRequest?.baseRef !== pullRequest.baseRef
    || openPullRequest?.baseSha.toLowerCase() !== pullRequest.baseSha.toLowerCase()
    || openPullRequest?.marker !== pullRequest.marker
    || openPullRequest?.closesIssueNumber !== pullRequest.closesIssueNumber
  ) return { status: "RESULT_UNKNOWN", outputSha: null, pullRequest: null };
  return { status: "VERIFIED", outputSha: pullRequest.headSha.toLowerCase(), pullRequest };
}

type GithubMutationStepLedgerEvidence = {
  kind: string;
  ordinal: number;
  status: string;
  generation: number;
  inputDigest: string | null;
  expectedTreeSha: string | null;
  expectedCommitSha: string | null;
  outputSha: string | null;
  outputNumber: number | null;
  outputNodeId: string | null;
  outputUrl: string | null;
  claimExpiresAt: Date | null;
  verifiedAt: Date | null;
};

type GithubMutationFinalPullRequestEvidence = {
  number: number;
  nodeId: string;
  url: string;
  headSha: string;
};

function finalPullRequestEvidence(value: {
  pullRequestNumber: number | null;
  pullRequestNodeId: string | null;
  pullRequestUrl: string | null;
  pullRequestHeadSha: string | null;
}): GithubMutationFinalPullRequestEvidence | null {
  if (
    !Number.isSafeInteger(value.pullRequestNumber)
    || (value.pullRequestNumber ?? 0) <= 0
    || !value.pullRequestNodeId
    || !value.pullRequestUrl
    || !value.pullRequestHeadSha
  ) return null;
  return {
    number: value.pullRequestNumber!,
    nodeId: value.pullRequestNodeId,
    url: value.pullRequestUrl,
    headSha: value.pullRequestHeadSha,
  };
}

/**
 * 최종 VERIFIED execution은 상태 문자열만 신뢰하지 않는다. 외부 mutation 순서와
 * 각 단계의 exact output이 모두 남아 있어야만 worker 완료 근거로 사용할 수 있다.
 */
export function githubMutationStepLedgerVerified(
  steps: readonly GithubMutationStepLedgerEvidence[],
  finalPullRequest?: GithubMutationFinalPullRequestEvidence | null,
): boolean {
  if (steps.length !== 3) return false;
  const [commit, ref, pullRequest] = [...steps].sort((left, right) => left.ordinal - right.ordinal);
  if (
    commit.kind !== "CREATE_COMMIT" || commit.ordinal !== 1
    || ref.kind !== "CREATE_REF" || ref.ordinal !== 2
    || pullRequest.kind !== "CREATE_PR" || pullRequest.ordinal !== 3
    || [commit, ref, pullRequest].some((step) => (
      step.status !== "VERIFIED"
      || step.generation <= 0
      || !step.inputDigest
      || step.claimExpiresAt !== null
      || step.verifiedAt === null
    ))
  ) return false;
  const expectedTreeSha = commit.expectedTreeSha?.toLowerCase() ?? null;
  const expectedCommitSha = commit.expectedCommitSha?.toLowerCase() ?? null;
  if (
    !expectedTreeSha
    || !expectedCommitSha
    || commit.outputSha?.toLowerCase() !== expectedCommitSha
    || commit.outputNumber !== null
    || commit.outputNodeId !== null
    || commit.outputUrl !== null
  ) return false;
  if ([ref, pullRequest].some((step) => (
    step.inputDigest !== commit.inputDigest
    || step.expectedTreeSha?.toLowerCase() !== expectedTreeSha
    || step.expectedCommitSha?.toLowerCase() !== expectedCommitSha
    || step.outputSha?.toLowerCase() !== expectedCommitSha
  ))) return false;
  return ref.outputNumber === null
    && ref.outputNodeId === null
    && ref.outputUrl === null
    && Number.isSafeInteger(pullRequest.outputNumber)
    && (pullRequest.outputNumber ?? 0) > 0
    && Boolean(pullRequest.outputNodeId)
    && Boolean(pullRequest.outputUrl)
    && (
      finalPullRequest === undefined
      || (
        finalPullRequest !== null
        && finalPullRequest.number === pullRequest.outputNumber
        && finalPullRequest.nodeId === pullRequest.outputNodeId
        && finalPullRequest.url === pullRequest.outputUrl
        && finalPullRequest.headSha.toLowerCase() === expectedCommitSha
      )
    );
}

export async function completeGithubMutationStep(input: {
  sessionId: string;
  executionId: string;
  stepId: string;
  attemptId: string;
  generation: number;
  workerPrincipalId: string;
  workerRuntimeBindingDigest: string;
  stepKind: AgentGithubMutationStepKind;
  observation: AgentGithubMutationStepObservation;
  adapterPrincipalId: string;
  adapterRuntimeIdentity: string;
  idempotencyKey: string;
  now?: Date;
  retryAttempt?: number;
}) {
  const now = input.now ?? new Date();
  const completionDigest = jsonDigest({
    sessionId: input.sessionId,
    executionId: input.executionId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    generation: input.generation,
    workerPrincipalId: input.workerPrincipalId,
    workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
    stepKind: input.stepKind,
    adapterPrincipalId: input.adapterPrincipalId,
    adapterRuntimeIdentity: input.adapterRuntimeIdentity,
    observation: stepObservationJson(input.observation),
  });
  const replay = await prisma.agentMutationStepAttempt.findUnique({
    where: { completionRequestId: input.idempotencyKey },
    include: {
      session: { include: activeMutationSessionInclude },
      step: { include: { execution: { include: mutationStepExecutionInclude } } },
    },
  });
  if (replay) {
    if (replay.id !== input.attemptId || replay.sessionId !== input.sessionId || replay.completionDigest !== completionDigest) {
      throw new ControlPlaneError("idempotency key가 다른 mutation step completion에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    mutationStepSessionMode({ execution: replay.step.execution, session: replay.session, ...input, now });
    return {
      executionId: input.executionId,
      stepId: replay.stepId,
      attemptId: replay.id,
      generation: replay.generation,
      status: replay.status as "VERIFIED" | "NOT_APPLIED" | "RESULT_UNKNOWN",
      duplicate: true,
    };
  }
  assertFreshObservation(input.observation as unknown as AgentGithubObservation, now);
  try {
    return await prisma.$transaction(async (tx) => {
      const attempt = await tx.agentMutationStepAttempt.findUnique({
        where: { id: input.attemptId },
        include: {
          step: { include: { execution: { include: mutationStepExecutionInclude } } },
          session: { include: activeMutationSessionInclude },
        },
      });
      if (!attempt || attempt.stepId !== input.stepId || attempt.step.executionId !== input.executionId) {
        throw new ControlPlaneError("mutation step attempt를 찾을 수 없습니다.", 404, "MUTATION_STEP_ATTEMPT_NOT_FOUND");
      }
      const execution = attempt.step.execution;
      const mode = mutationStepSessionMode({ execution, session: attempt.session, ...input, now });
      if (
        attempt.step.kind !== input.stepKind
        || attempt.generation !== input.generation
        || attempt.step.generation !== input.generation
        || attempt.sessionId !== input.sessionId
        || attempt.sessionId !== attempt.session.id
        || attempt.principalId !== input.workerPrincipalId
        || attempt.runtimeBindingDigest !== input.workerRuntimeBindingDigest
        || attempt.adapterPrincipalId !== input.adapterPrincipalId
        || attempt.adapterRuntimeIdentity !== input.adapterRuntimeIdentity
        || attempt.expiresAt <= now
        || attempt.step.claimExpiresAt === null
        || attempt.step.claimExpiresAt <= now
        || !["CLAIMED", "PLANNED"].includes(attempt.status)
        || !["CLAIMED", "PLANNED"].includes(attempt.step.status)
      ) throw new ControlPlaneError("mutation step completion이 stale 상태입니다.", 409, "STALE_MUTATION_STEP_ATTEMPT");
      if (input.stepKind === "CREATE_COMMIT" && attempt.step.status !== "PLANNED" && mode !== "READBACK") {
        throw new ControlPlaneError("CREATE_COMMIT은 durable plan 뒤에만 완료할 수 있습니다.", 409, "MUTATION_COMMIT_PLAN_REQUIRED");
      }
      const disposition = githubMutationStepDisposition({
        stepKind: input.stepKind,
        observation: input.observation,
        grant: execution.grant,
        expectedTreeSha: attempt.step.expectedTreeSha,
        expectedCommitSha: attempt.step.expectedCommitSha,
      });
      const attemptUpdate = await tx.agentMutationStepAttempt.updateMany({
        where: {
          id: attempt.id,
          generation: input.generation,
          status: { in: ["CLAIMED", "PLANNED"] },
          expiresAt: { gt: now },
        },
        data: {
          status: disposition.status,
          completionRequestId: input.idempotencyKey,
          completionDigest,
          completedAt: now,
        },
      });
      const nextStepStatus = disposition.status === "NOT_APPLIED" ? "PENDING" : disposition.status;
      const stepUpdate = await tx.agentMutationStep.updateMany({
        where: {
          id: attempt.step.id,
          generation: input.generation,
          status: { in: ["CLAIMED", "PLANNED"] },
          claimExpiresAt: { gt: now },
        },
        data: {
          status: nextStepStatus,
          outputSha: disposition.outputSha,
          outputNumber: disposition.pullRequest?.number ?? null,
          outputNodeId: disposition.pullRequest?.nodeId ?? null,
          outputUrl: disposition.pullRequest?.url ?? null,
          lastReadbackDigest: jsonDigest(stepObservationJson(input.observation)),
          claimExpiresAt: null,
          verifiedAt: disposition.status === "VERIFIED" ? now : null,
        },
      });
      if (attemptUpdate.count !== 1 || stepUpdate.count !== 1) {
        throw new ControlPlaneError("mutation step completion generation CAS가 충돌했습니다.", 409, "MUTATION_STEP_CAS_CONFLICT");
      }
      await tx.agentMutationExecution.update({
        where: { id: execution.id },
        data: { status: disposition.status === "RESULT_UNKNOWN" ? "RESULT_UNKNOWN" : "IN_PROGRESS" },
      });
      await tx.agentRunEvent.create({
        data: {
          runId: execution.runId,
          type: disposition.status === "VERIFIED"
            ? "mutation_step_verified"
            : disposition.status === "NOT_APPLIED"
              ? "mutation_step_not_applied"
              : "mutation_step_unknown",
          generation: attempt.session.generation,
          actor: input.adapterPrincipalId,
          payload: {
            executionId: execution.id,
            stepId: input.stepId,
            stepKind: input.stepKind,
            stepGeneration: input.generation,
            attemptId: input.attemptId,
            status: disposition.status,
            ...(disposition.outputSha ? { outputSha: disposition.outputSha } : {}),
            ...(disposition.pullRequest ? {
              pullRequestNumber: disposition.pullRequest.number,
              pullRequestUrl: disposition.pullRequest.url,
            } : {}),
          },
        },
      });
      return {
        executionId: execution.id,
        stepId: input.stepId,
        attemptId: input.attemptId,
        generation: input.generation,
        status: disposition.status,
        duplicate: false,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && ["P2002", "P2034"].includes(error.code)
      && (input.retryAttempt ?? 0) < 2
    ) return completeGithubMutationStep({ ...input, now, retryAttempt: (input.retryAttempt ?? 0) + 1 });
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
    || (grant.issueNumber !== null && !githubIssueEligible(observation.issue))
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
  if (!["CONSUMED", "IN_PROGRESS", "RESULT_UNKNOWN"].includes(input.currentStatus)) {
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
  sessionId: string;
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
    include: { execution: true, observation: true },
  });
  if (replay) {
    if (
      replay.executionId !== input.executionId
      || replay.observation.sessionId !== input.sessionId
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
        include: mutationStepExecutionInclude,
      });
      if (!execution) throw new ControlPlaneError("mutation execution을 찾을 수 없습니다.", 404, "MUTATION_EXECUTION_NOT_FOUND");
      const session = await tx.agentWorkerSession.findUnique({
        where: { id: input.sessionId },
        include: activeMutationSessionInclude,
      });
      if (!session) throw new ControlPlaneError("agent worker session을 찾을 수 없습니다.", 404, "SESSION_NOT_FOUND");
      const mode = mutationStepSessionMode({ execution, session, ...input, now });
      if (mode !== "START") {
        await assertMutationSessionAudit({
          tx,
          execution,
          session,
          mode,
          adapterPrincipalId: input.adapterPrincipalId,
          adapterRuntimeIdentity: input.adapterRuntimeIdentity,
        });
      }
      const disposition = githubMutationReadbackDisposition({ observation: input.observation, grant: execution.grant });
      const allStepsVerified = githubMutationStepLedgerVerified(
        execution.steps,
        disposition.status === "VERIFIED" && disposition.pullRequest
          ? {
            number: disposition.pullRequest.number,
            nodeId: disposition.pullRequest.nodeId,
            url: disposition.pullRequest.url,
            headSha: disposition.pullRequest.headSha,
          }
          : disposition.status === "VERIFIED"
            ? null
            : undefined,
      );
      const anyStepStarted = execution.steps.some((step) => step.generation > 0 || step.status !== "PENDING");
      const anyStepVerified = execution.steps.some((step) => step.status === "VERIFIED");
      const status = disposition.status === "VERIFIED" && !allStepsVerified
        ? "RESULT_UNKNOWN" as const
        : disposition.status === "NOT_APPLIED" && anyStepStarted && !(mode === "READBACK" && !anyStepVerified)
          ? "RESULT_UNKNOWN" as const
          : disposition.status;
      const pullRequest = status === "VERIFIED" ? disposition.pullRequest : null;
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
          sessionId: session.id,
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
          generation: session.generation,
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
    include: {
      grant: true,
      steps: true,
      readbacks: {
        include: { observation: { select: { sessionId: true } } },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const mutationStarted = executions.some((execution) => execution.status !== "NOT_APPLIED");
  const unresolvedMutation = executions.some((execution) => (
    execution.status !== "NOT_APPLIED"
    && (
      execution.status !== "VERIFIED"
      || !githubMutationStepLedgerVerified(execution.steps, finalPullRequestEvidence(execution))
    )
  ));
  const verifiedMutation = executions.some((execution) => (
    execution.status === "VERIFIED"
    && githubMutationStepLedgerVerified(execution.steps, finalPullRequestEvidence(execution))
  ));
  const outcomeCode = String(input.result.outcomeCode ?? "");
  const executionId = typeof input.result.mutationExecutionId === "string"
    ? input.result.mutationExecutionId
    : null;
  const externallyStartedExecutions = executions.filter((execution) => execution.status !== "NOT_APPLIED");
  const unresolvedExecution = externallyStartedExecutions.length === 1
    ? externallyStartedExecutions[0]
    : null;
  const latestReadback = unresolvedExecution?.readbacks?.[0];
  const currentSessionUnknownReadbackConfirmed = input.readbackResolution
    && outcomeCode === "READBACK_CONFIRMED"
    && unresolvedExecution?.status === "RESULT_UNKNOWN"
    && latestReadback !== undefined
    && unresolvedExecution.readbackObservationId === latestReadback?.observationId
    && latestReadback.status === "RESULT_UNKNOWN"
    && latestReadback.observation.sessionId === input.sessionId;
  if (outcomeCode === "PR_READY") {
    if (!executionId) return { mutationStarted, error: "TRUSTED_MUTATION_EVIDENCE_REQUIRED" };
    const execution = executions.find((candidate) => candidate.id === executionId);
    if (
      execution?.status === "VERIFIED"
      && !githubMutationStepLedgerVerified(execution.steps, finalPullRequestEvidence(execution))
    ) {
      return { mutationStarted, error: "TRUSTED_MUTATION_STEP_EVIDENCE_REQUIRED" };
    }
    if (
      !execution
      || execution.status !== "VERIFIED"
      || execution.pullRequestNumber !== input.result.pullRequestNumber
      || execution.pullRequestUrl !== input.result.pullRequestUrl
      || (input.result.commitSha && execution.pullRequestHeadSha !== String(input.result.commitSha).toLowerCase())
    ) return { mutationStarted, error: "TRUSTED_MUTATION_RESULT_MISMATCH" };
    return { mutationStarted: true, error: null };
  }
  if (
    (unresolvedMutation || verifiedMutation)
    && outcomeCode !== "RESULT_UNKNOWN"
    && !currentSessionUnknownReadbackConfirmed
  ) {
    return { mutationStarted: true, error: "TRUSTED_MUTATION_READBACK_REQUIRED" };
  }
  if (executionId && !executions.some((candidate) => candidate.id === executionId)) {
    return { mutationStarted, error: "TRUSTED_MUTATION_RESULT_MISMATCH" };
  }
  return { mutationStarted, error: null };
}
