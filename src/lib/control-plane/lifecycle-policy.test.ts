import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { FleetLifecycleStage } from "@prisma/client";

import { RELEASE_CANDIDATE_REQUIRED_GATES, RELEASE_GATE_NAMES } from "@/lib/control-plane/contracts";
import {
  EVIDENCE_ONLY_STAGES,
  FLEET_LIFECYCLE_STAGES,
  GATE_IDENTITY_REQUIREMENT,
  HUMAN_TRANSITION_STAGES,
  evidenceLifecycleStage,
  gateIdentitySatisfied,
  humanLifecycleTransitionDecision,
  lifecycleStageRank,
  type GateObservationFact,
} from "@/lib/control-plane/lifecycle-policy";

const base = new Date("2026-08-01T00:00:00.000Z");

function fact(
  gate: string,
  overrides: Partial<GateObservationFact> = {},
): GateObservationFact {
  return {
    id: `${gate}-${overrides.observedAt?.toISOString() ?? "0"}`,
    gate,
    status: "PASSED",
    observedAt: base,
    createdAt: base,
    providerReference: GATE_IDENTITY_REQUIREMENT[gate as keyof typeof GATE_IDENTITY_REQUIREMENT] === "providerReference"
      ? "provider-ref-1"
      : null,
    publicIdentity: gate === "PUBLIC" ? "https://play.google.com/store/apps/details?id=x" : null,
    ...overrides,
  };
}

function requiredGateFacts(): GateObservationFact[] {
  return RELEASE_CANDIDATE_REQUIRED_GATES.map((gate) => fact(gate));
}

test("lifecycle 14단계는 Prisma enum과 정확히 같은 집합과 순서다", () => {
  assert.deepEqual([...FLEET_LIFECYCLE_STAGES], Object.values(FleetLifecycleStage));
  assert.equal(FLEET_LIFECYCLE_STAGES.length, 14);
  assert.deepEqual(
    [...HUMAN_TRANSITION_STAGES, ...EVIDENCE_ONLY_STAGES],
    FLEET_LIFECYCLE_STAGES.slice(1),
  );
});

test("사람 전이는 IDEA~RELEASE_ASSETS 구간에서 한 단계씩만 전진한다", () => {
  assert.deepEqual(humanLifecycleTransitionDecision({ from: "IDEA", to: "PLANNING" }), { ok: true });
  assert.deepEqual(humanLifecycleTransitionDecision({ from: "QA", to: "RELEASE_ASSETS" }), { ok: true });

  const skipped = humanLifecycleTransitionDecision({ from: "IDEA", to: "APPROVED" });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.ok === false && skipped.code, "STAGE_SKIP_FORBIDDEN");

  const regressed = humanLifecycleTransitionDecision({ from: "BUILD", to: "PLANNING" });
  assert.equal(regressed.ok === false && regressed.code, "STAGE_REGRESSION_FORBIDDEN");

  const same = humanLifecycleTransitionDecision({ from: "BUILD", to: "BUILD" });
  assert.equal(same.ok === false && same.code, "STAGE_REGRESSION_FORBIDDEN");

  const unknown = humanLifecycleTransitionDecision({ from: "IDEA", to: "SHIPPED" });
  assert.equal(unknown.ok === false && unknown.code, "STAGE_UNKNOWN");
});

test("사람 전이는 RELEASE_CANDIDATE 이후 어떤 단계도 열 수 없다", () => {
  for (const stage of EVIDENCE_ONLY_STAGES) {
    const decision = humanLifecycleTransitionDecision({
      from: FLEET_LIFECYCLE_STAGES[lifecycleStageRank(stage) - 1],
      to: stage,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.code, "EVIDENCE_REQUIRED_STAGE");
  }
});

test("필수 6 gate가 전부 PASSED여야 RELEASE_CANDIDATE 자동 승격이 일어난다", () => {
  assert.equal(evidenceLifecycleStage([]), null);
  assert.equal(evidenceLifecycleStage(requiredGateFacts().slice(0, 5)), null);
  assert.equal(evidenceLifecycleStage(requiredGateFacts()), "RELEASE_CANDIDATE");

  const failed = requiredGateFacts();
  failed[2] = fact("ARTIFACT", { status: "FAILED" });
  assert.equal(evidenceLifecycleStage(failed), null);
});

test("외부 단계는 대응 gate가 누적으로 PASSED일 때만 순서대로 전진한다", () => {
  const upload = [...requiredGateFacts(), fact("UPLOAD")];
  assert.equal(evidenceLifecycleStage(upload), "SUBMITTED");

  // REVIEW gate만 있고 PROCESSING/DEVICE_QA가 없으면 건너뛰지 않는다.
  assert.equal(evidenceLifecycleStage([...upload, fact("REVIEW")]), "SUBMITTED");

  const reviewed = [...upload, fact("PROCESSING"), fact("DEVICE_QA"), fact("REVIEW")];
  assert.equal(evidenceLifecycleStage(reviewed), "REVIEW");
  assert.equal(evidenceLifecycleStage([...reviewed, fact("APPROVAL")]), "APPROVED_FOR_RELEASE");

  // DEPLOYMENT만 앞질러 와도 APPROVAL 없이는 전진하지 않는다.
  assert.equal(evidenceLifecycleStage([...reviewed, fact("DEPLOYMENT")]), "REVIEW");

  const deployed = [...reviewed, fact("APPROVAL"), fact("DEPLOYMENT")];
  assert.equal(evidenceLifecycleStage(deployed), "DEPLOYED");
  assert.equal(evidenceLifecycleStage([...deployed, fact("PUBLIC")]), "PUBLIC_VERIFIED");
});

test("identity 증거가 없는 PASSED 관측은 외부 단계를 전진시키지 않는다", () => {
  const noReference = [...requiredGateFacts(), fact("UPLOAD", { providerReference: null })];
  assert.equal(evidenceLifecycleStage(noReference), "RELEASE_CANDIDATE");

  const publicWithoutIdentity = [
    ...requiredGateFacts(),
    fact("UPLOAD"),
    fact("PROCESSING"),
    fact("DEVICE_QA"),
    fact("REVIEW"),
    fact("APPROVAL"),
    fact("DEPLOYMENT"),
    fact("PUBLIC", { publicIdentity: null }),
  ];
  assert.equal(evidenceLifecycleStage(publicWithoutIdentity), "DEPLOYED");

  assert.equal(gateIdentitySatisfied({ gate: "UPLOAD", providerReference: null, publicIdentity: "x" }), false);
  assert.equal(gateIdentitySatisfied({ gate: "PUBLIC", providerReference: "x", publicIdentity: null }), false);
  assert.equal(gateIdentitySatisfied({ gate: "CI", providerReference: null, publicIdentity: null }), true);
});

test("MONITORED는 같은 공개 identity의 PUBLIC 관측이 서로 다른 시점에 두 번 남을 때만 도달한다", () => {
  const deployed = [
    ...requiredGateFacts(),
    fact("UPLOAD"),
    fact("PROCESSING"),
    fact("DEVICE_QA"),
    fact("REVIEW"),
    fact("APPROVAL"),
    fact("DEPLOYMENT"),
  ];
  const later = new Date(base.getTime() + 86_400_000);
  assert.equal(evidenceLifecycleStage([...deployed, fact("PUBLIC")]), "PUBLIC_VERIFIED");
  assert.equal(
    evidenceLifecycleStage([
      ...deployed,
      fact("PUBLIC"),
      fact("PUBLIC", { observedAt: later, publicIdentity: "https://apps.apple.com/app/id1" }),
    ]),
    "PUBLIC_VERIFIED",
  );
  assert.equal(
    evidenceLifecycleStage([...deployed, fact("PUBLIC"), fact("PUBLIC", { observedAt: later })]),
    "MONITORED",
  );
});

test("최신 관측이 FAILED면 앞선 PASSED 관측으로 전진하지 않는다", () => {
  const later = new Date(base.getTime() + 60_000);
  const observations = [
    ...requiredGateFacts(),
    fact("UPLOAD"),
    fact("UPLOAD", { observedAt: later, status: "FAILED" }),
  ];
  assert.equal(evidenceLifecycleStage(observations), "RELEASE_CANDIDATE");
});

test("gate identity 요구는 13개 gate 전체를 빠짐없이 선언한다", () => {
  assert.deepEqual(Object.keys(GATE_IDENTITY_REQUIREMENT).sort(), [...RELEASE_GATE_NAMES].sort());
});

test("lifecycle 전이 경로는 라벨·마일스톤을 읽지 않고 사람 경로는 server action 전용이다", () => {
  const policy = readFileSync(join(process.cwd(), "src/lib/control-plane/lifecycle-policy.ts"), "utf8");
  assert.doesNotMatch(policy, /label|milestone/i);

  const service = readFileSync(join(process.cwd(), "src/lib/control-plane/lifecycle-service.ts"), "utf8");
  assert.match(service, /humanLifecycleTransitionDecision/);
  assert.match(service, /generation: input\.expectedGeneration/);
  assert.match(service, /idempotencyKey: input\.idempotencyKey/);
  assert.match(service, /auditLog\.create/);
  assert.match(service, /Serializable/);

  const actions = readFileSync(join(process.cwd(), "src/lib/actions/fleet-control-plane.ts"), "utf8");
  assert.match(actions, /advanceFleetLifecycleStageAction/);
  assert.match(actions, /fleetWriteContext\(input\.appId\)/);

  const ledger = readFileSync(join(process.cwd(), "src/lib/control-plane/release-ledger.ts"), "utf8");
  assert.match(ledger, /evidenceLifecycleStage/);
  assert.match(ledger, /GATE_IDENTITY_REQUIRED/);
  assert.match(ledger, /lifecycleStageRank\(state\.stage\) < lifecycleStageRank\(evidenceStage\)/);
});
