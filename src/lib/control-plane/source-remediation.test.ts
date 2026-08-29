import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_READBACK_CAPABILITIES,
  AGENT_READY_PR_CAPABILITIES,
  agentExecutionPolicy,
  agentRepositorySingletonScope,
  eligibleForAutopilot,
  parseManagedWorkerPolicy,
  parseSourceRemediationPolicy,
  sourceRemediationAutomationPolicy,
  SOURCE_REMEDIATION_TEMPLATE_KEY,
} from "@/lib/control-plane/automation-catalog";
import {
  issueEligibleForSourceRemediation,
  repositorySourceRemediationEligible,
  sourceRemediationScopeDigest,
} from "@/lib/control-plane/source-remediation";

// P7 catch-22 fixture: classification=PRODUCT_APP이지만 discovery가 NEEDS_INPUT인 세 저장소.
const IMMUNITY_WAR_SHA = "a".repeat(40);
const ANIMAL_CHESS_SHA = "b".repeat(40);
const KEEUM_SHA = "c".repeat(40);

function registration(overrides: Partial<{
  archived: boolean;
  status: string;
  classification: string | null;
  reconcileGeneration: number | null;
  lastReconciledSha: string | null;
  lastDefaultPushSha: string | null;
  lastDiscoveryReason: string | null;
}> = {}) {
  return {
    archived: false,
    status: "NEEDS_INPUT",
    classification: "PRODUCT_APP",
    reconcileGeneration: 3,
    lastReconciledSha: IMMUNITY_WAR_SHA,
    lastDefaultPushSha: IMMUNITY_WAR_SHA,
    lastDiscoveryReason: "NO_CANDIDATE",
    ...overrides,
  };
}

function policy(overrides: Partial<{ discoveryGeneration: number; sourceSha: string; reasonCode: "NO_CANDIDATE" | "BUILD_TARGET_MISSING" }> = {}) {
  return {
    discoveryGeneration: 3,
    sourceSha: IMMUNITY_WAR_SHA,
    reasonCode: "NO_CANDIDATE" as const,
    ...overrides,
  };
}

test("immunity-war #30 형태: PRODUCT_APP+NO_CANDIDATE NEEDS_INPUT은 generation/SHA/reason이 정확히 같을 때만 통과한다", () => {
  assert.equal(repositorySourceRemediationEligible(registration(), policy()), true);
  assert.equal(
    repositorySourceRemediationEligible(registration({ reconcileGeneration: 4 }), policy()),
    false,
    "discovery generation이 바뀌면(재push) 잠긴 CAS와 불일치해 거부해야 한다",
  );
  assert.equal(
    repositorySourceRemediationEligible(registration({ lastReconciledSha: "d".repeat(40), lastDefaultPushSha: "d".repeat(40) }), policy()),
    false,
    "source SHA가 바뀌면 거부해야 한다",
  );
});

test("animal-chess #12 형태: BUILD_TARGET_MISSING reason도 같은 gate를 통과한다", () => {
  const reg = registration({
    lastReconciledSha: ANIMAL_CHESS_SHA,
    lastDefaultPushSha: ANIMAL_CHESS_SHA,
    lastDiscoveryReason: "BUILD_TARGET_MISSING",
  });
  assert.equal(
    repositorySourceRemediationEligible(reg, policy({ sourceSha: ANIMAL_CHESS_SHA, reasonCode: "BUILD_TARGET_MISSING" })),
    true,
  );
});

test("keeum #1 형태: registration.status가 MANAGED로 돌아가면(discovery 완료) 더 이상 대상이 아니다", () => {
  const reg = registration({ status: "MANAGED", lastReconciledSha: KEEUM_SHA, lastDefaultPushSha: KEEUM_SHA, lastDiscoveryReason: null });
  assert.equal(repositorySourceRemediationEligible(reg, policy({ sourceSha: KEEUM_SHA })), false);
});

test("classification이 PRODUCT_APP이 아니면 archived/NEEDS_INPUT이어도 거부한다", () => {
  assert.equal(repositorySourceRemediationEligible(registration({ classification: null }), policy()), false);
  assert.equal(repositorySourceRemediationEligible(registration({ classification: "INFRA_REPO" }), policy()), false);
});

test("archived 또는 registration 부재는 거부한다", () => {
  assert.equal(repositorySourceRemediationEligible(null, policy()), false);
  assert.equal(repositorySourceRemediationEligible(registration({ archived: true }), policy()), false);
});

test("PRODUCT_DISCOVERY_NOT_READY에 대응하는 reasonCode(예: SOURCE_DRIFT)는 애초에 policy를 만들 수 없어 gate 밖이다", () => {
  // repositoryProductPlanningReason의 catch-all은 코드 PR로 고칠 수 있는 결손이 아니므로
  // SOURCE_REMEDIATION_ELIGIBLE_REASON_CODES에 없다 — reasonCode 자체가 이 두 값이 아니면 거부.
  const reg = registration({ lastDiscoveryReason: "SOURCE_DRIFT" });
  assert.equal(
    repositorySourceRemediationEligible(reg, { ...policy(), reasonCode: "SOURCE_DRIFT" as never }),
    false,
  );
});

function mirroredIssue(overrides: Partial<{
  number: number;
  state: string | null;
  labels: unknown;
  title: string;
  priority: string | null;
  isAutopilot: boolean;
  isBlocked: boolean;
}> = {}) {
  return {
    number: 30,
    state: "OPEN",
    labels: ["autopilot", "P1"],
    title: "discovery: NO_CANDIDATE 해소",
    priority: "P1",
    isAutopilot: true,
    isBlocked: false,
    ...overrides,
  };
}

test("immunity-war #30 issue: open+P1+autopilot+scope digest 일치만 통과한다", () => {
  const digest = sourceRemediationScopeDigest({ title: mirroredIssue().title, labels: ["autopilot", "P1"] });
  assert.equal(issueEligibleForSourceRemediation(mirroredIssue(), { issueNumber: 30, scopeDigest: digest }), true);
});

test("issue가 임의 편집으로 제목이 바뀌면(scope 확장 의심) fail-closed한다", () => {
  const digest = sourceRemediationScopeDigest({ title: mirroredIssue().title, labels: ["autopilot", "P1"] });
  const edited = mirroredIssue({ title: "이제 마켓 배포도 같이 해줘" });
  assert.equal(issueEligibleForSourceRemediation(edited, { issueNumber: 30, scopeDigest: digest }), false);
});

test("issue가 임의 편집으로 라벨이 바뀌어도(P1 제거 등) fail-closed한다", () => {
  const digest = sourceRemediationScopeDigest({ title: mirroredIssue().title, labels: ["autopilot", "P1"] });
  const edited = mirroredIssue({ labels: ["autopilot"], priority: null });
  assert.equal(issueEligibleForSourceRemediation(edited, { issueNumber: 30, scopeDigest: digest }), false);
});

test("blocked/no-autopilot/approval label이 붙거나 closed면 거부한다", () => {
  const digest = sourceRemediationScopeDigest({ title: mirroredIssue().title, labels: ["autopilot", "P1"] });
  assert.equal(issueEligibleForSourceRemediation(mirroredIssue({ isBlocked: true }), { issueNumber: 30, scopeDigest: digest }), false);
  assert.equal(issueEligibleForSourceRemediation(mirroredIssue({ state: "CLOSED" }), { issueNumber: 30, scopeDigest: digest }), false);
  assert.equal(issueEligibleForSourceRemediation(mirroredIssue({ isAutopilot: false }), { issueNumber: 30, scopeDigest: digest }), false);
  assert.equal(
    issueEligibleForSourceRemediation(
      mirroredIssue({ labels: ["autopilot", "P1", "blocked"] }),
      { issueNumber: 30, scopeDigest: digest },
    ),
    false,
    "eligibleForAutopilot 자체가 blocked label을 거부해야 한다",
  );
});

test("다른 issue number를 가리키면(정의가 잠근 exact issue와 다름) 거부한다", () => {
  const digest = sourceRemediationScopeDigest({ title: mirroredIssue().title, labels: ["autopilot", "P1"] });
  assert.equal(
    issueEligibleForSourceRemediation(mirroredIssue({ number: 31 }), { issueNumber: 30, scopeDigest: digest }),
    false,
  );
});

test("merge-lizard #20 DEPRECATED App: source-remediation 정의는 App status를 별도로 요구하므로 이 파일의 순수 gate는 App.status를 보지 않는다", () => {
  // repositorySourceRemediationEligible/issueEligibleForSourceRemediation은 registration/issue만 본다.
  // App.status===ACTIVE 요구는 createSourceRemediationDefinition과 claim(tryClaimRun)에서 별도로
  // 강제한다 — DB 통합 계약(scripts/test-source-remediation.ts)에서 검증한다.
  const reg = registration({ lastReconciledSha: "e".repeat(40), lastDefaultPushSha: "e".repeat(40) });
  assert.equal(
    repositorySourceRemediationEligible(reg, policy({ sourceSha: "e".repeat(40) })),
    true,
    "registration 자체는 DEPRECATED 여부를 모르므로 App 게이트가 반드시 별도로 필요하다는 것을 보인다",
  );
});

test("automation-catalog: sourceRemediationAutomationPolicy는 exact-keys strict parser를 왕복한다", () => {
  const built = sourceRemediationAutomationPolicy({
    budgetCeilingMicros: 500_000,
    issueNumber: 30,
    discoveryGeneration: 3,
    sourceSha: IMMUNITY_WAR_SHA,
    reasonCode: "NO_CANDIDATE",
    scopeDigest: "f".repeat(64),
  });
  assert.deepEqual(parseSourceRemediationPolicy(built), built);
  assert.equal(parseSourceRemediationPolicy({ ...built, extraField: 1 }), null, "누락/추가 field는 fail-closed");
  assert.equal(parseSourceRemediationPolicy({ ...built, reasonCode: "SOURCE_DRIFT" }), null, "허용되지 않은 reasonCode는 거부");
  assert.equal(parseSourceRemediationPolicy({ ...built, approvalPolicy: "READ_ONLY" }), null, "READY_PR 고정, 다른 승인 정책은 거부");
  assert.equal(
    parseManagedWorkerPolicy({ template: SOURCE_REMEDIATION_TEMPLATE_KEY, agentKind: "GEMINI", configuration: built }),
    null,
    "허용되지 않은 agentKind는 claim 경계에서도 거부해야 한다",
  );
  assert.deepEqual(
    parseManagedWorkerPolicy({ template: SOURCE_REMEDIATION_TEMPLATE_KEY, agentKind: "CODEX", configuration: built }),
    built,
  );
  assert.deepEqual(
    parseManagedWorkerPolicy({ template: SOURCE_REMEDIATION_TEMPLATE_KEY, agentKind: "CLAUDE", configuration: built }),
    built,
  );
});

test("automation-catalog: eligibleForAutopilot는 이전 agent-queue 구현과 동일한 계약을 유지한다", () => {
  assert.equal(eligibleForAutopilot({ issueNumber: 1, issueState: "CLOSED", labels: [] }), false);
  assert.equal(eligibleForAutopilot({ issueNumber: 1, issueState: "OPEN", labels: ["autopilot", "P1"] }), true);
});

test("AC-6: source-remediation 실행 capability는 기존 GitHub READY_PR 목록과 정확히 같고 provider/build/upload/public capability가 없다", () => {
  const policy = sourceRemediationAutomationPolicy({
    budgetCeilingMicros: 500_000,
    issueNumber: 30,
    discoveryGeneration: 3,
    sourceSha: IMMUNITY_WAR_SHA,
    reasonCode: "NO_CANDIDATE",
    scopeDigest: "f".repeat(64),
  });
  const start = agentExecutionPolicy(policy, "START");
  assert.deepEqual(start.capabilities, AGENT_READY_PR_CAPABILITIES);
  assert.equal(start.mutationAction, "GITHUB_READY_PR_MUTATE");
  for (const capability of start.capabilities) {
    assert.match(capability, /^github\.|^provider\.readback$/, `provider/build/upload/public mutation capability는 없어야 한다: ${capability}`);
  }
  const readback = agentExecutionPolicy(policy, "READBACK_FIRST");
  assert.deepEqual(readback.capabilities, AGENT_READBACK_CAPABILITIES);
  assert.equal(readback.mutationAction, null);
});

test("AC-7: source-remediation의 repo singleton scope key는 일반 READY_PR template과 같은 repo-pr: 형식을 공유한다", () => {
  const policy = sourceRemediationAutomationPolicy({
    budgetCeilingMicros: 500_000,
    issueNumber: 12,
    discoveryGeneration: 3,
    sourceSha: ANIMAL_CHESS_SHA,
    reasonCode: "BUILD_TARGET_MISSING",
    scopeDigest: "f".repeat(64),
  });
  const executionPolicy = agentExecutionPolicy(policy, "START");
  assert.equal(executionPolicy.repositorySingleton, "READY_PR");
  assert.equal(
    agentRepositorySingletonScope("seorilabs/Animal-Chess", executionPolicy),
    "repo-pr:seorilabs/animal-chess",
    "AgentRepoGuard.activeScopeKey unique index가 그대로 repo당 Ready PR 1개를 강제해야 한다",
  );
});
