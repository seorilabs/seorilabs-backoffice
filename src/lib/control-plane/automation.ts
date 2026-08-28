import crypto from "node:crypto";

import type {
  AutomationAgentKind,
  AutomationCadence,
} from "@/lib/control-plane/automation-catalog";

export {
  AUTOMATION_APPROVAL_POLICIES,
  AUTOMATION_AGENT_KINDS,
  AUTOMATION_CADENCES,
  AUTOMATION_TEMPLATE_KEY,
  AUTOMATION_TEMPLATES,
  automationPolicy,
  isManagedAutomationDefinition,
  parseManagedAutomationPolicy,
  parseAutomationPolicy,
} from "@/lib/control-plane/automation-catalog";
export type {
  AutomationAgentKind,
  AutomationApprovalPolicy,
  AutomationCadence,
  AutomationPolicy,
} from "@/lib/control-plane/automation-catalog";

const CADENCE_SCHEDULE: Record<AutomationCadence, string | null> = {
  MANUAL: null,
  HOURLY: "0 * * * *",
  DAILY: "0 0 * * *",
};

export function scheduleForCadence(cadence: AutomationCadence): string | null {
  return CADENCE_SCHEDULE[cadence];
}

export function cadenceForSchedule(schedule: string | null): AutomationCadence | null {
  const entry = Object.entries(CADENCE_SCHEDULE).find(([, value]) => value === schedule);
  return (entry?.[0] as AutomationCadence | undefined) ?? null;
}

function floorUtc(value: Date, cadence: Exclude<AutomationCadence, "MANUAL">): Date {
  const result = new Date(value);
  result.setUTCMinutes(0, 0, 0);
  if (cadence === "DAILY") result.setUTCHours(0);
  return result;
}

function advance(value: Date, cadence: Exclude<AutomationCadence, "MANUAL">): Date {
  return new Date(value.getTime() + (cadence === "HOURLY" ? 60 * 60_000 : 24 * 60 * 60_000));
}

/**
 * 마지막으로 기록된 slot 다음부터 현재 UTC 경계까지를 반환한다.
 * 한 번에 제한을 넘으면 다음 reconcile이 마지막 occurrence부터 이어서 소진한다.
 */
export function dueScheduleSlots(input: {
  cadence: AutomationCadence;
  createdAt: Date;
  lastScheduledFor: Date | null;
  now: Date;
  limit?: number;
}): Date[] {
  if (input.cadence === "MANUAL") return [];
  const limit = Math.max(1, Math.min(input.limit ?? 200, 2_000));
  const cadence = input.cadence;
  const currentBoundary = floorUtc(input.now, cadence);
  const anchor = input.lastScheduledFor ?? input.createdAt;
  let slot = advance(floorUtc(anchor, cadence), cadence);
  const slots: Date[] = [];
  while (slot <= currentBoundary && slots.length < limit) {
    slots.push(slot);
    slot = advance(slot, cadence);
  }
  return slots;
}

export function automationIdempotencyKey(input: {
  definitionId: string;
  triggerKind: "MANUAL" | "SCHEDULE" | "WEBHOOK";
  triggerKey: string;
}): string {
  return crypto.createHash("sha256")
    .update(`${input.definitionId}:${input.triggerKind}:${input.triggerKey}`)
    .digest("hex");
}

export function definitionKey(input: {
  appId: string;
  template: string;
  agentKind: AutomationAgentKind;
  cadence: AutomationCadence;
}): string {
  const suffix = crypto.createHash("sha256")
    .update(`${input.appId}:${input.template}:${input.agentKind}:${input.cadence}`)
    .digest("hex")
    .slice(0, 20);
  return `${input.template}:${input.agentKind.toLowerCase()}:${input.cadence.toLowerCase()}:${suffix}`;
}

export interface ProjectFieldSource {
  [key: string]: string | null;
  priority: string | null;
  app: string;
  kind: string;
  lifecycle: string;
  agent: string;
  approval: string;
  outcome: string;
}

/** GitHub Project의 표시값만 만든다. 이 결과는 claim eligibility에 사용하지 않는다. */
export function fleetProjectFields(input: {
  appSlug: string;
  lifecycle: string;
  priority: string | null;
  labels: readonly string[];
  agentKind?: string | null;
  runStatus?: string | null;
  issueState: string;
}): ProjectFieldSource {
  const labels = input.labels.map((label) => label.toLowerCase());
  const kind = input.labels.find((label) => /^kind:/i.test(label))?.slice("kind:".length)
    ?? (labels.includes("platform-contract") ? "platform-contract" : labels.includes("platform") ? "platform" : "app");
  const approval = input.labels.find((label) => /^approval:/i.test(label))?.slice("approval:".length)
    ?? "NONE";
  return {
    priority: input.priority,
    app: input.appSlug,
    kind,
    lifecycle: input.lifecycle,
    agent: input.agentKind ?? "UNASSIGNED",
    approval,
    outcome: input.runStatus ?? input.issueState,
  };
}
