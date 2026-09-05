export const AUTOMATION_TEMPLATE_KEY = "repo-task-autopilot-v1" as const;
export const PLATFORM_FLEET_AUTOMATION_TEMPLATE_KEY = "platform-fleet-reconcile-v1" as const;
// P7 catch-22 전용: classification=PRODUCT_APP이지만 discovery가 NEEDS_INPUT인 repository의
// discovery 결손(NO_CANDIDATE/BUILD_TARGET_MISSING)만 고치는 단발성 routine이다. 일반
// repositoryAutomationEligible MANAGED guard는 그대로 두고, 이 template 전용 좁은 gate만 우회한다.
export const SOURCE_REMEDIATION_TEMPLATE_KEY = "repo-source-remediation-v1" as const;
export const WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY =
  "workflow-bundle-candidate-executor-v1" as const;
// 승인된 WorkflowBundle의 caller를 대상 저장소 main에 반증하는 실행기다. 후보 canary와
// 달리 승인 번들 하나만 대상으로 하고, caller 본문은 중앙 계약이 만든다.
export const APPROVED_CALLER_RECONCILIATION_EXECUTOR_TEMPLATE_KEY =
  "approved-caller-reconciliation-executor-v1" as const;
export const MANAGED_WORKER_TEMPLATE_KEYS = [
  AUTOMATION_TEMPLATE_KEY,
  PLATFORM_FLEET_AUTOMATION_TEMPLATE_KEY,
  SOURCE_REMEDIATION_TEMPLATE_KEY,
] as const;
export const AUTOMATION_CADENCES = ["MANUAL", "HOURLY", "DAILY"] as const;
export const AUTOMATION_AGENT_KINDS = ["CODEX", "CLAUDE"] as const;
export const AUTOMATION_APPROVAL_POLICIES = ["READY_PR", "READ_ONLY"] as const;
// registration.lastDiscoveryReason이 이 두 값일 때만 explicit PRODUCT_APP decision이
// source-remediation 대상이 된다. repositoryProductPlanningReason의 PRODUCT_DISCOVERY_NOT_READY
// catch-all(SOURCE_DRIFT, APP_IDENTITY_CONFLICT 등)은 코드 PR로 고칠 수 있는 결손이 아니므로 제외한다.
export const SOURCE_REMEDIATION_ELIGIBLE_REASON_CODES = ["NO_CANDIDATE", "BUILD_TARGET_MISSING"] as const;
export const GENERIC_WORKER_PRINCIPALS = {
  CODEX: "codex:seorilabs-generic-worker",
  CLAUDE: "claude:seorilabs-generic-worker",
} as const;
export const WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL =
  "seori-auth:workflow-bundle-candidate-executor" as const;
export const APPROVED_CALLER_RECONCILIATION_EXECUTOR_PRINCIPAL =
  "seori-auth:approved-caller-reconciliation-executor" as const;
/** admin token으로 승격될 수 없는 실행기 principal 전체다. security gate가 읽는다. */
export const TRUSTED_EXECUTOR_PRINCIPALS = [
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
  APPROVED_CALLER_RECONCILIATION_EXECUTOR_PRINCIPAL,
] as const;

export type AutomationCadence = typeof AUTOMATION_CADENCES[number];
export type AutomationAgentKind = typeof AUTOMATION_AGENT_KINDS[number];
export type AutomationApprovalPolicy = typeof AUTOMATION_APPROVAL_POLICIES[number];
export type SourceRemediationEligibleReasonCode = typeof SOURCE_REMEDIATION_ELIGIBLE_REASON_CODES[number];

export interface AutomationPolicy {
  [key: string]: string | number | boolean;
  schemaVersion: 1;
  approvalPolicy: AutomationApprovalPolicy;
  budgetCeilingMicros: number;
  createsPr: boolean;
  claimSource:
    | "github-issue-mirror"
    | "platform-fleet-plan"
    | "source-remediation-issue"
    | "workflow-bundle-candidate"
    | "approved-caller-reconciliation";
}

export const WORKFLOW_BUNDLE_CANDIDATE_AUTOMATION_POLICY = Object.freeze({
  schemaVersion: 1,
  approvalPolicy: "READY_PR",
  budgetCeilingMicros: 1,
  createsPr: true,
  claimSource: "workflow-bundle-candidate",
} satisfies AutomationPolicy);

export const APPROVED_CALLER_RECONCILIATION_AUTOMATION_POLICY = Object.freeze({
  schemaVersion: 1,
  approvalPolicy: "READY_PR",
  budgetCeilingMicros: 1,
  createsPr: true,
  claimSource: "approved-caller-reconciliation",
} satisfies AutomationPolicy);

/** 신뢰 실행기 정의는 정책을 한 글자도 바꿀 수 없다. exact key/value가 아니면 거부한다. */
function parseExactTrustedExecutorPolicy(
  value: unknown,
  expected: AutomationPolicy,
): AutomationPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const source = expected as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expectedKeys = Object.keys(source).sort();
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || expectedKeys.some((key) => candidate[key] !== source[key])
  ) return null;
  return expected;
}

/**
 * 정의 시점에 잠근 exact 대상: repo numeric ID(appId로 결합), 단일 issue, discovery
 * generation/source SHA/reason, issue 제목+라벨 scope digest. claim 시 이 값 그대로
 * registration/IssueMirror와 다시 CAS 비교하며, 정의 이후에는 바꿀 수 없다.
 */
export interface SourceRemediationPolicy extends AutomationPolicy {
  claimSource: "source-remediation-issue";
  issueNumber: number;
  discoveryGeneration: number;
  sourceSha: string;
  reasonCode: SourceRemediationEligibleReasonCode;
  scopeDigest: string;
}

export const AGENT_READBACK_CAPABILITIES = [
  "github.issue.read",
  "github.pull_request.read",
  "provider.readback",
] as const;

export const AGENT_READY_PR_CAPABILITIES = [
  ...AGENT_READBACK_CAPABILITIES,
  "github.branch.write",
  "github.commit.write",
  "github.pull_request.create",
] as const;

export interface AgentExecutionPolicy {
  capabilities: readonly string[];
  repositorySingleton: "READY_PR" | null;
  mutationAction: "GITHUB_READY_PR_MUTATE" | null;
}

/** Repo singleton과 mutation 권한은 mutable AgentRun.createsPr가 아니라 signed definition 정책에서 파생한다. */
export function agentExecutionPolicy(
  policy: AutomationPolicy,
  resumeMode: "START" | "READBACK_FIRST",
): AgentExecutionPolicy {
  if (resumeMode === "READBACK_FIRST") {
    return {
      capabilities: AGENT_READBACK_CAPABILITIES,
      repositorySingleton: policy.approvalPolicy === "READY_PR" ? "READY_PR" : null,
      mutationAction: null,
    };
  }
  if (policy.approvalPolicy === "READY_PR") {
    return {
      capabilities: AGENT_READY_PR_CAPABILITIES,
      repositorySingleton: "READY_PR",
      mutationAction: "GITHUB_READY_PR_MUTATE",
    };
  }
  return { capabilities: AGENT_READBACK_CAPABILITIES, repositorySingleton: null, mutationAction: null };
}

export function agentRepositorySingletonScope(
  repoFullName: string,
  executionPolicy: AgentExecutionPolicy,
): string | null {
  return executionPolicy.repositorySingleton === "READY_PR"
    ? `repo-pr:${repoFullName.toLowerCase()}`
    : null;
}

export function platformFleetAutomationPolicy(input: {
  budgetCeilingMicros: number;
}): AutomationPolicy {
  return {
    schemaVersion: 1,
    approvalPolicy: "READY_PR",
    budgetCeilingMicros: input.budgetCeilingMicros,
    createsPr: true,
    claimSource: "platform-fleet-plan",
  };
}

export function automationPolicy(input: {
  approvalPolicy: AutomationApprovalPolicy;
  budgetCeilingMicros: number;
}): AutomationPolicy {
  return {
    schemaVersion: 1,
    approvalPolicy: input.approvalPolicy,
    budgetCeilingMicros: input.budgetCeilingMicros,
    createsPr: input.approvalPolicy === "READY_PR",
    claimSource: "github-issue-mirror",
  };
}

export function parseAutomationPolicy(value: unknown): AutomationPolicy {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const approvalPolicy = AUTOMATION_APPROVAL_POLICIES.includes(
    candidate.approvalPolicy as AutomationApprovalPolicy,
  ) ? candidate.approvalPolicy as AutomationApprovalPolicy : "READY_PR";
  const budgetCeilingMicros = Number(candidate.budgetCeilingMicros);
  return automationPolicy({
    approvalPolicy,
    budgetCeilingMicros: Number.isSafeInteger(budgetCeilingMicros) && budgetCeilingMicros > 0
      ? budgetCeilingMicros
      : 1_000_000,
  });
}

/** 기존 AutomationDefinition의 누락 field를 기본값으로 승격하지 않는 실행용 parser. */
export function parseManagedAutomationPolicy(value: unknown): AutomationPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expectedKeys = [
    "approvalPolicy",
    "budgetCeilingMicros",
    "claimSource",
    "createsPr",
    "schemaVersion",
  ].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return null;
  if (candidate.schemaVersion !== 1 || candidate.claimSource !== "github-issue-mirror") return null;
  if (!AUTOMATION_APPROVAL_POLICIES.includes(candidate.approvalPolicy as AutomationApprovalPolicy)) return null;
  if (!Number.isSafeInteger(candidate.budgetCeilingMicros) || Number(candidate.budgetCeilingMicros) <= 0) return null;
  const policy = automationPolicy({
    approvalPolicy: candidate.approvalPolicy as AutomationApprovalPolicy,
    budgetCeilingMicros: Number(candidate.budgetCeilingMicros),
  });
  return candidate.createsPr === policy.createsPr ? policy : null;
}

export function parseManagedPlatformFleetPolicy(value: unknown): AutomationPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expectedKeys = [
    "approvalPolicy",
    "budgetCeilingMicros",
    "claimSource",
    "createsPr",
    "schemaVersion",
  ].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return null;
  if (
    candidate.schemaVersion !== 1
    || candidate.claimSource !== "platform-fleet-plan"
    || candidate.approvalPolicy !== "READY_PR"
    || candidate.createsPr !== true
    || !Number.isSafeInteger(candidate.budgetCeilingMicros)
    || Number(candidate.budgetCeilingMicros) <= 0
  ) return null;
  return platformFleetAutomationPolicy({ budgetCeilingMicros: Number(candidate.budgetCeilingMicros) });
}

export function sourceRemediationAutomationPolicy(input: {
  budgetCeilingMicros: number;
  issueNumber: number;
  discoveryGeneration: number;
  sourceSha: string;
  reasonCode: SourceRemediationEligibleReasonCode;
  scopeDigest: string;
}): SourceRemediationPolicy {
  return {
    schemaVersion: 1,
    approvalPolicy: "READY_PR",
    budgetCeilingMicros: input.budgetCeilingMicros,
    createsPr: true,
    claimSource: "source-remediation-issue",
    issueNumber: input.issueNumber,
    discoveryGeneration: input.discoveryGeneration,
    sourceSha: input.sourceSha,
    reasonCode: input.reasonCode,
    scopeDigest: input.scopeDigest,
  };
}

/** 정의 생성 이후 수정 경로가 없는 exact 대상 잠금. 누락/추가 field는 전부 fail-closed다. */
export function parseSourceRemediationPolicy(value: unknown): SourceRemediationPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expectedKeys = [
    "approvalPolicy",
    "budgetCeilingMicros",
    "claimSource",
    "createsPr",
    "discoveryGeneration",
    "issueNumber",
    "reasonCode",
    "schemaVersion",
    "scopeDigest",
    "sourceSha",
  ].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return null;
  if (
    candidate.schemaVersion !== 1
    || candidate.claimSource !== "source-remediation-issue"
    || candidate.approvalPolicy !== "READY_PR"
    || candidate.createsPr !== true
    || !Number.isSafeInteger(candidate.budgetCeilingMicros)
    || Number(candidate.budgetCeilingMicros) <= 0
    || !Number.isSafeInteger(candidate.issueNumber)
    || Number(candidate.issueNumber) <= 0
    || !Number.isSafeInteger(candidate.discoveryGeneration)
    || Number(candidate.discoveryGeneration) < 0
    || typeof candidate.sourceSha !== "string"
    || !/^[0-9a-f]{40}$/i.test(candidate.sourceSha)
    || typeof candidate.scopeDigest !== "string"
    || !/^[0-9a-f]{64}$/i.test(candidate.scopeDigest)
    || !SOURCE_REMEDIATION_ELIGIBLE_REASON_CODES.includes(candidate.reasonCode as SourceRemediationEligibleReasonCode)
  ) return null;
  return sourceRemediationAutomationPolicy({
    budgetCeilingMicros: Number(candidate.budgetCeilingMicros),
    issueNumber: Number(candidate.issueNumber),
    discoveryGeneration: Number(candidate.discoveryGeneration),
    sourceSha: candidate.sourceSha.toLowerCase(),
    reasonCode: candidate.reasonCode as SourceRemediationEligibleReasonCode,
    scopeDigest: candidate.scopeDigest.toLowerCase(),
  });
}

/** worker claim 경계는 UI에서 만드는 이슈 routine과 내부 Platform plan, source-remediation 단발 대상을 함께 수용한다. */
export function parseManagedWorkerPolicy(input: {
  template: string;
  agentKind: string | null;
  configuration: unknown;
}): AutomationPolicy | null {
  if (input.template === AUTOMATION_TEMPLATE_KEY) {
    return AUTOMATION_AGENT_KINDS.includes(input.agentKind as AutomationAgentKind)
      ? parseManagedAutomationPolicy(input.configuration)
      : null;
  }
  if (input.template === PLATFORM_FLEET_AUTOMATION_TEMPLATE_KEY) {
    return input.agentKind === "CODEX"
      ? parseManagedPlatformFleetPolicy(input.configuration)
      : null;
  }
  if (input.template === SOURCE_REMEDIATION_TEMPLATE_KEY) {
    return AUTOMATION_AGENT_KINDS.includes(input.agentKind as AutomationAgentKind)
      ? parseSourceRemediationPolicy(input.configuration)
      : null;
  }
  if (input.template === WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY) {
    return input.agentKind === null
      ? parseExactTrustedExecutorPolicy(
          input.configuration,
          WORKFLOW_BUNDLE_CANDIDATE_AUTOMATION_POLICY,
        )
      : null;
  }
  if (input.template === APPROVED_CALLER_RECONCILIATION_EXECUTOR_TEMPLATE_KEY) {
    return input.agentKind === null
      ? parseExactTrustedExecutorPolicy(
          input.configuration,
          APPROVED_CALLER_RECONCILIATION_AUTOMATION_POLICY,
        )
      : null;
  }
  return null;
}

export function isManagedWorkerDefinition(input: {
  template: string;
  agentKind: string | null;
  configuration: unknown;
}): boolean {
  return parseManagedWorkerPolicy(input) !== null;
}

export function isManagedAutomationDefinition(input: {
  template: string;
  agentKind: string | null;
  configuration: unknown;
}): boolean {
  return input.template === AUTOMATION_TEMPLATE_KEY
    && AUTOMATION_AGENT_KINDS.includes(input.agentKind as AutomationAgentKind)
    && parseManagedAutomationPolicy(input.configuration) !== null;
}

export function eligibleForAutopilot(input: {
  issueNumber?: number | null;
  issueState?: string | null;
  labels: unknown;
}): boolean {
  if (input.issueNumber && input.issueState?.toUpperCase() !== "OPEN") return false;
  const labels = Array.isArray(input.labels)
    ? input.labels.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase())
    : [];
  if (input.issueNumber && !labels.includes("autopilot")) return false;
  return !labels.some((label) =>
    label === "blocked" || label === "no-autopilot" || label.startsWith("approval:"),
  );
}

export const AUTOMATION_TEMPLATES = [{
  key: AUTOMATION_TEMPLATE_KEY,
  name: "레포 이슈 자율 소진",
  description: "승인 gate가 없는 autopilot 이슈 한 건을 claim하고 Ready PR까지 처리합니다.",
  createsPr: true,
  allowedAgents: AUTOMATION_AGENT_KINDS,
}] as const;
