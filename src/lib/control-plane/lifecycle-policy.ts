import { z } from "zod";

import {
  RELEASE_CANDIDATE_REQUIRED_GATES,
  type ReleaseGateName,
} from "@/lib/control-plane/contracts";

/**
 * 중앙 lifecycle의 14단계 순서다. Prisma `FleetLifecycleStage` enum과 정확히 같은 집합이며
 * 순서가 rank를 정의한다. 이 목록 밖의 값은 전이 정책이 판정하지 않는다.
 */
export const FLEET_LIFECYCLE_STAGES = [
  "IDEA",
  "PLANNING",
  "SPEC_REVIEW",
  "APPROVED",
  "BUILD",
  "QA",
  "RELEASE_ASSETS",
  "RELEASE_CANDIDATE",
  "SUBMITTED",
  "REVIEW",
  "APPROVED_FOR_RELEASE",
  "DEPLOYED",
  "PUBLIC_VERIFIED",
  "MONITORED",
] as const;

export type FleetLifecycleStageName = typeof FLEET_LIFECYCLE_STAGES[number];

/**
 * 사람 server action이 전진시킬 수 있는 유일한 구간이다.
 * IDEA에서 시작해 RELEASE_ASSETS까지는 자동 증거가 존재하지 않으므로 신뢰된 로컬 사람 조작만 허용한다.
 */
export const HUMAN_TRANSITION_STAGES = [
  "PLANNING",
  "SPEC_REVIEW",
  "APPROVED",
  "BUILD",
  "QA",
  "RELEASE_ASSETS",
] as const satisfies readonly FleetLifecycleStageName[];

export type HumanTransitionStage = typeof HUMAN_TRANSITION_STAGES[number];

/** RELEASE_CANDIDATE 이후는 append-only gate observation 증거로만 전진한다. */
export const EVIDENCE_ONLY_STAGES = [
  "RELEASE_CANDIDATE",
  "SUBMITTED",
  "REVIEW",
  "APPROVED_FOR_RELEASE",
  "DEPLOYED",
  "PUBLIC_VERIFIED",
  "MONITORED",
] as const satisfies readonly FleetLifecycleStageName[];

/**
 * 외부 provider 단계는 자기 단계에 대응하는 gate가 전부 PASSED여야 전진한다.
 * 앞 단계의 gate 요구는 누적되므로 관측이 빠진 단계를 건너뛸 수 없다.
 */
export const EXTERNAL_STAGE_GATES = {
  SUBMITTED: ["UPLOAD"],
  REVIEW: ["PROCESSING", "DEVICE_QA", "REVIEW"],
  APPROVED_FOR_RELEASE: ["APPROVAL"],
  DEPLOYED: ["DEPLOYMENT"],
  PUBLIC_VERIFIED: ["PUBLIC"],
  MONITORED: [],
} as const satisfies Record<string, readonly ReleaseGateName[]>;

/**
 * gate별로 PASSED 관측이 반드시 들고 있어야 하는 identity 증거다.
 * release-candidate를 만드는 6개 gate는 기존 계약을 그대로 유지한다.
 */
export const GATE_IDENTITY_REQUIREMENT = {
  IMPLEMENTATION: "none",
  CI: "none",
  ARTIFACT: "none",
  RELEASE_ASSETS: "none",
  COMPLIANCE_DRAFT: "none",
  PROVIDER_SHELL: "none",
  UPLOAD: "providerReference",
  PROCESSING: "providerReference",
  DEVICE_QA: "providerReference",
  REVIEW: "providerReference",
  APPROVAL: "providerReference",
  DEPLOYMENT: "providerReference",
  PUBLIC: "publicIdentity",
} as const satisfies Record<ReleaseGateName, "none" | "providerReference" | "publicIdentity">;

export function lifecycleStageRank(stage: string): number {
  return (FLEET_LIFECYCLE_STAGES as readonly string[]).indexOf(stage);
}

export function isFleetLifecycleStage(value: string): value is FleetLifecycleStageName {
  return lifecycleStageRank(value) >= 0;
}

export const fleetLifecycleHumanTransitionSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  toStage: z.enum(HUMAN_TRANSITION_STAGES),
  expectedGeneration: z.number().int().nonnegative(),
}).strict();

export type HumanLifecycleTransitionDecision =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * 사람 전이는 앞으로 한 단계씩만 허용한다. 되돌림, 건너뜀, 증거 전용 구간 진입을 모두 거부한다.
 */
export function humanLifecycleTransitionDecision(input: {
  from: string;
  to: string;
}): HumanLifecycleTransitionDecision {
  const fromRank = lifecycleStageRank(input.from);
  const toRank = lifecycleStageRank(input.to);
  if (fromRank < 0 || toRank < 0) {
    return { ok: false, code: "STAGE_UNKNOWN", message: "알 수 없는 lifecycle 단계입니다." };
  }
  if (!(HUMAN_TRANSITION_STAGES as readonly string[]).includes(input.to)) {
    return {
      ok: false,
      code: "EVIDENCE_REQUIRED_STAGE",
      message: `${input.to} 단계는 append-only gate 증거로만 전진합니다.`,
    };
  }
  if (toRank <= fromRank) {
    return {
      ok: false,
      code: "STAGE_REGRESSION_FORBIDDEN",
      message: "lifecycle 단계는 되돌릴 수 없습니다.",
    };
  }
  if (toRank !== fromRank + 1) {
    return {
      ok: false,
      code: "STAGE_SKIP_FORBIDDEN",
      message: "lifecycle 단계는 한 번에 한 단계씩만 전진할 수 있습니다.",
    };
  }
  return { ok: true };
}

export interface GateObservationFact {
  id: string;
  gate: string;
  status: string;
  observedAt: Date;
  createdAt: Date;
  providerReference: string | null;
  publicIdentity: string | null;
}

export function gateIdentitySatisfied(fact: {
  gate: string;
  providerReference: string | null;
  publicIdentity: string | null;
}): boolean {
  const requirement = (GATE_IDENTITY_REQUIREMENT as Record<string, string | undefined>)[fact.gate];
  if (requirement === "providerReference") return Boolean(fact.providerReference);
  if (requirement === "publicIdentity") return Boolean(fact.publicIdentity);
  return true;
}

function latestByGate(observations: GateObservationFact[]): Map<string, GateObservationFact> {
  const latest = new Map<string, GateObservationFact>();
  for (const observation of [...observations].sort((left, right) => (
    right.observedAt.getTime() - left.observedAt.getTime()
    || right.createdAt.getTime() - left.createdAt.getTime()
    || right.id.localeCompare(left.id)
  ))) {
    if (!latest.has(observation.gate)) latest.set(observation.gate, observation);
  }
  return latest;
}

function gatePassedWithIdentity(latest: Map<string, GateObservationFact>, gate: ReleaseGateName): boolean {
  const observation = latest.get(gate);
  return Boolean(observation && observation.status === "PASSED" && gateIdentitySatisfied(observation));
}

/**
 * 같은 공개 identity의 PUBLIC 관측이 서로 다른 시점에 두 번 이상 PASSED로 남았을 때만
 * 공개 상태가 계속 관측되고 있다고 본다. MONITORED는 이 지속 관측만을 근거로 한다.
 */
function sustainedPublicReadback(observations: GateObservationFact[]): boolean {
  const byIdentity = new Map<string, Set<number>>();
  for (const observation of observations) {
    if (observation.gate !== "PUBLIC" || observation.status !== "PASSED") continue;
    if (!observation.publicIdentity) continue;
    const times = byIdentity.get(observation.publicIdentity) ?? new Set<number>();
    times.add(observation.observedAt.getTime());
    byIdentity.set(observation.publicIdentity, times);
  }
  for (const times of byIdentity.values()) {
    if (times.size >= 2) return true;
  }
  return false;
}

/**
 * 하나의 release candidate가 가진 append-only 관측만으로 도달 가능한 최고 단계를 계산한다.
 * 라벨, 마일스톤, 사람 입력은 이 계산에 들어가지 않는다.
 */
export function evidenceLifecycleStage(
  observations: GateObservationFact[],
): FleetLifecycleStageName | null {
  const latest = latestByGate(observations);
  const candidateReady = RELEASE_CANDIDATE_REQUIRED_GATES
    .every((gate) => gatePassedWithIdentity(latest, gate));
  if (!candidateReady) return null;
  let reached: FleetLifecycleStageName = "RELEASE_CANDIDATE";
  for (const stage of ["SUBMITTED", "REVIEW", "APPROVED_FOR_RELEASE", "DEPLOYED", "PUBLIC_VERIFIED"] as const) {
    if (!EXTERNAL_STAGE_GATES[stage].every((gate) => gatePassedWithIdentity(latest, gate))) break;
    reached = stage;
  }
  if (reached === "PUBLIC_VERIFIED" && sustainedPublicReadback(observations)) return "MONITORED";
  return reached;
}
