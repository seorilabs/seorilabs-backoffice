export const AUTOMATION_TEMPLATE_KEY = "repo-task-autopilot-v1" as const;
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
  claimSource: "github-issue-mirror";
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

export const AUTOMATION_TEMPLATES = [{
  key: AUTOMATION_TEMPLATE_KEY,
  name: "레포 이슈 자율 소진",
  description: "승인 gate가 없는 autopilot 이슈 한 건을 claim하고 Ready PR까지 처리합니다.",
  createsPr: true,
  allowedAgents: AUTOMATION_AGENT_KINDS,
}] as const;
