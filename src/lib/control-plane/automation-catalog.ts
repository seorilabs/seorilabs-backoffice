export const AUTOMATION_TEMPLATE_KEY = "repo-task-autopilot-v1" as const;
export const PLATFORM_FLEET_AUTOMATION_TEMPLATE_KEY = "platform-fleet-reconcile-v1" as const;
export const MANAGED_WORKER_TEMPLATE_KEYS = [
  AUTOMATION_TEMPLATE_KEY,
  PLATFORM_FLEET_AUTOMATION_TEMPLATE_KEY,
] as const;
export const AUTOMATION_CADENCES = ["MANUAL", "HOURLY", "DAILY"] as const;
export const AUTOMATION_AGENT_KINDS = ["CODEX", "CLAUDE"] as const;
export const AUTOMATION_APPROVAL_POLICIES = ["READY_PR", "READ_ONLY"] as const;
export const GENERIC_WORKER_PRINCIPALS = {
  CODEX: "codex:seorilabs-generic-worker",
  CLAUDE: "claude:seorilabs-generic-worker",
} as const;

export type AutomationCadence = typeof AUTOMATION_CADENCES[number];
export type AutomationAgentKind = typeof AUTOMATION_AGENT_KINDS[number];
export type AutomationApprovalPolicy = typeof AUTOMATION_APPROVAL_POLICIES[number];

export interface AutomationPolicy {
  [key: string]: string | number | boolean;
  schemaVersion: 1;
  approvalPolicy: AutomationApprovalPolicy;
  budgetCeilingMicros: number;
  createsPr: boolean;
  claimSource: "github-issue-mirror" | "platform-fleet-plan";
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

/** worker claim 경계는 UI에서 만드는 이슈 routine과 내부 Platform plan을 함께 수용한다. */
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

export const AUTOMATION_TEMPLATES = [{
  key: AUTOMATION_TEMPLATE_KEY,
  name: "레포 이슈 자율 소진",
  description: "승인 gate가 없는 autopilot 이슈 한 건을 claim하고 Ready PR까지 처리합니다.",
  createsPr: true,
  allowedAgents: AUTOMATION_AGENT_KINDS,
}] as const;
