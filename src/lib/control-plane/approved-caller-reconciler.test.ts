import assert from "node:assert/strict";
import test from "node:test";

import {
  callerReconciliationDigest,
  planApprovedCallerReconciliation,
  type CallerReconciliationVerdict,
} from "@/lib/control-plane/approved-caller-reconciler";
import { ControlPlaneError } from "@/lib/control-plane/service";

const REPO_ID = 1250442131n;
const FULL_NAME = "seorilabs/happy-farm";

function registryRecord(overrides: Record<string, unknown> = {}) {
  return {
    approvalState: "APPROVED",
    sourceSha: "a".repeat(40),
    bundle: { source: { sha: "a".repeat(40) } },
    ...overrides,
  };
}

function client(overrides: {
  records?: Array<Record<string, unknown>>;
  apps?: Array<Record<string, unknown>>;
  registration?: Record<string, unknown> | null;
  discovery?: Record<string, unknown> | null;
} = {}) {
  return {
    workflowBundleRegistryRecord: {
      async findMany() {
        return overrides.records ?? [registryRecord()];
      },
    },
    app: {
      async findMany() {
        return overrides.apps ?? [
          { id: "app-1", repoId: REPO_ID, repoFullName: FULL_NAME, status: "ACTIVE" },
        ];
      },
    },
    repositoryRegistration: {
      async findUnique() {
        return overrides.registration === undefined
          ? { defaultBranch: "main", archived: false, classification: "PRODUCT_APP" }
          : overrides.registration;
      },
    },
    discoveryObservation: {
      async findFirst() {
        return overrides.discovery === undefined
          ? { sourceSha: "b".repeat(40) }
          : overrides.discovery;
      },
    },
    configRevision: { async findFirst() { return null; } },
    async $transaction() { throw new Error("not used"); },
  };
}

// 계약 구현은 주입한다. 계획 로직(대상 선정과 비교)만 여기서 검사하고, caller 내용은
// 중앙 계약이 만든다는 사실 자체를 호출로 확인한다.
const CALLER = "name: Org Contract\n";
function contract(calls: string[] = []) {
  return {
    async loadApprovedWorkflowBundleV5() { calls.push("loadApproved"); return {}; },
    async loadResolvedWorkflowBindingV5() { calls.push("loadResolved"); return {}; },
    generateStaticCallerV5() { calls.push("generateCaller"); return CALLER; },
  };
}

function verifiedBundle() {
  return {
    approved: {
      integrity: { payloadDigest: `sha256:${"1".repeat(64)}` },
      source: { sha: "a".repeat(40), workflowExecutionSha: "a".repeat(40) },
      approval: { signature: { keyId: "key-1", policyRevision: "policy-1" } },
    },
    candidate: {},
    envelope: {
      candidateDigest: `sha256:${"2".repeat(64)}`,
      contractDigestsDigest: `sha256:${"3".repeat(64)}`,
      runtimeAssetDigestsDigest: `sha256:${"4".repeat(64)}`,
      evidenceDigest: `sha256:${"5".repeat(64)}`,
    },
    approvalPayloadDigest: `sha256:${"6".repeat(64)}`,
  };
}

const dependencies = {
  trustedApprovalKeysJson: JSON.stringify({ schemaVersion: 1, keys: [] }),
  contract: contract(),
  verifyApprovedBundle: (() => verifiedBundle()) as never,
  contractRepoRoot: "/unit-test/contract-root",
  resolveManifest: (async () => ({
    state: "VERIFIED",
    repositoryId: "1250442131",
    fullName: FULL_NAME,
    bindingSourceSha: "b".repeat(40),
    manifestDigest: `sha256:${"7".repeat(64)}`,
    manifest: {
      configRevisionId: "config-1",
      configRevision: 4,
      configRevisionDigest: `sha256:${"8".repeat(64)}`,
      signedSnapshotDigest: `sha256:${"9".repeat(64)}`,
      snapshotSignature: { keyId: "k", policyRevision: "p", digest: `sha256:${"a".repeat(64)}` },
    },
  })) as never,
  readRepositoryCaller: async () => null,
};

const options = {
  signingKey: "unit-test-key",
  snapshotSignatureKeyId: "control-plane-snapshot-v1",
  snapshotSignaturePolicyRevision: "snapshot-policy-v1",
  now: new Date("2026-09-05T00:00:00Z"),
};

test("승인된 번들이 없으면 계획 자체를 거부한다", async () => {
  await assert.rejects(
    planApprovedCallerReconciliation(options, client({ records: [] }) as never, dependencies),
    (error) => error instanceof ControlPlaneError
      && error.code === "NO_APPROVED_WORKFLOW_BUNDLE",
  );
});

test("승인된 번들이 둘 이상이면 어느 것을 고정할지 정할 수 없으므로 거부한다", async () => {
  await assert.rejects(
    planApprovedCallerReconciliation(
      options,
      client({ records: [registryRecord(), registryRecord({ sourceSha: "c".repeat(40) })] }) as never,
      dependencies,
    ),
    (error) => error instanceof ControlPlaneError
      && error.code === "AMBIGUOUS_APPROVED_WORKFLOW_BUNDLE",
  );
});

test("등록·분류·앱 상태가 어긋난 저장소는 이유를 남기고 건너뛴다", async () => {
  const cases: Array<[Parameters<typeof client>[0], string]> = [
    [{ registration: null }, "REPOSITORY_NOT_REGISTERED"],
    [
      { registration: { defaultBranch: "main", archived: true, classification: "PRODUCT_APP" } },
      "REPOSITORY_NOT_REGISTERED",
    ],
    [
      { registration: { defaultBranch: "main", archived: false, classification: "INFRA_REPO" } },
      "REPOSITORY_NOT_PRODUCT_APP",
    ],
    [
      { apps: [{ id: "app-1", repoId: REPO_ID, repoFullName: FULL_NAME, status: "PAUSED" }] },
      "APP_NOT_ACTIVE",
    ],
    [{ discovery: null }, "NO_DEFAULT_BRANCH_DISCOVERY"],
  ];
  for (const [overrides, reasonCode] of cases) {
    const verdicts = await planApprovedCallerReconciliation(
      options,
      client(overrides) as never,
      dependencies,
    );
    assert.equal(verdicts.length, 1, reasonCode);
    assert.equal(verdicts[0]!.state, "SKIPPED", reasonCode);
    assert.equal(verdicts[0]!.reasonCode, reasonCode);
    assert.equal(verdicts[0]!.desiredCaller, null);
  }
});

test("GitHub 저장소에 결합되지 않은 App은 대상에서 빠진다", async () => {
  const verdicts = await planApprovedCallerReconciliation(
    options,
    client({ apps: [{ id: "app-1", repoId: null, repoFullName: FULL_NAME, status: "ACTIVE" }] }) as never,
    dependencies,
  );
  assert.deepEqual(verdicts, []);
});

test("caller가 저장소에 없으면 PR이 필요하다고, 같으면 동기 상태로 판정한다", async () => {
  const calls: string[] = [];
  const missing = await planApprovedCallerReconciliation(options, client() as never, {
    ...dependencies,
    contract: contract(calls),
    readRepositoryCaller: async () => null,
  });
  assert.equal(missing[0]!.state, "PULL_REQUEST_REQUIRED");
  assert.equal(missing[0]!.desiredCaller, CALLER);
  assert.equal(missing[0]!.callerPath, ".github/workflows/org-contract.yml");
  // caller 내용은 중앙 계약이 만든다. 이 모듈은 규칙을 다시 쓰지 않는다.
  assert.deepEqual(calls, ["loadApproved", "loadResolved", "generateCaller"]);

  const inSync = await planApprovedCallerReconciliation(options, client() as never, {
    ...dependencies,
    contract: contract(),
    readRepositoryCaller: async () => CALLER,
  });
  assert.equal(inSync[0]!.state, "IN_SYNC");

  const drifted = await planApprovedCallerReconciliation(options, client() as never, {
    ...dependencies,
    contract: contract(),
    readRepositoryCaller: async () => "name: Org Contract\n# 손으로 바꾼 흔적\n",
  });
  assert.equal(drifted[0]!.state, "PULL_REQUEST_REQUIRED");
});

test("매니페스트 구성이 거부하면 그 코드를 이유로 남기고 건너뛴다", async () => {
  const verdicts = await planApprovedCallerReconciliation(options, client() as never, {
    ...dependencies,
    resolveManifest: (async () => {
      throw new ControlPlaneError("활성 설정 없음", 409, "NO_ACTIVE_CONFIG");
    }) as never,
  });
  assert.equal(verdicts[0]!.state, "SKIPPED");
  assert.equal(verdicts[0]!.reasonCode, "NO_ACTIVE_CONFIG");
});

test("계약이 매니페스트를 신뢰하지 못하면 그 저장소만 건너뛴다", async () => {
  const verdicts = await planApprovedCallerReconciliation(options, client() as never, {
    ...dependencies,
    contract: {
      ...contract(),
      async loadResolvedWorkflowBindingV5() {
        throw new Error("RESOLVED_BINDING_READBACK_UNTRUSTED");
      },
    },
  });
  assert.equal(verdicts[0]!.state, "SKIPPED");
  assert.equal(verdicts[0]!.reasonCode, "CALLER_GENERATION_FAILED");
});

test("계획 digest는 계약 정규화를 쓴다", () => {
  const verdicts: CallerReconciliationVerdict[] = [{
    repositoryId: "1",
    fullName: FULL_NAME,
    state: "IN_SYNC",
    reasonCode: null,
    callerPath: ".github/workflows/org-contract.yml",
    desiredCaller: null,
  }];
  const digest = callerReconciliationDigest(verdicts);
  assert.ok(digest.startsWith('[{"callerPath"'));
  assert.ok(digest.includes('"state":"IN_SYNC"'));
});

test("기본 검증자는 서명되지 않은 번들을 거부한다", async () => {
  // verifyApprovedBundle을 대체하지 않으면 registry의 실제 서명 검증이 돈다.
  await assert.rejects(
    planApprovedCallerReconciliation(options, client() as never, {
      trustedApprovalKeysJson: JSON.stringify({ schemaVersion: 1, keys: [] }),
      contract: contract(),
      contractRepoRoot: "/unit-test/contract-root",
      readRepositoryCaller: async () => null,
    }),
    (error) => error instanceof ControlPlaneError
      && error.code === "APPROVED_WORKFLOW_BUNDLE_UNTRUSTED",
  );
});

test("caller reconciliation 경로는 인증 없는 요청을 401로 막고 잘못된 repositoryId를 거부한다", async () => {
  const previous = process.env.INTERNAL_ADMIN_TOKEN;
  process.env.INTERNAL_ADMIN_TOKEN = "test-internal-token";
  try {
    const { GET } = await import("@/app/api/control-plane/caller-reconciliation/route");
    const { NextRequest } = await import("next/server");
    const unauthorized = await GET(
      new NextRequest("https://backoffice.vzyx.xyz/api/control-plane/caller-reconciliation"),
    );
    assert.equal(unauthorized.status, 401);

    const badId = await GET(new NextRequest(
      "https://backoffice.vzyx.xyz/api/control-plane/caller-reconciliation?repositoryId=abc",
    ));
    // 인증이 형식 검사보다 먼저 걸린다.
    assert.equal(badId.status, 401);
  } finally {
    if (previous === undefined) delete process.env.INTERNAL_ADMIN_TOKEN;
    else process.env.INTERNAL_ADMIN_TOKEN = previous;
  }
});

test("caller 읽기 권한은 대상 저장소의 contents 읽기 하나로 제한된다", async () => {
  const { FLEET_GITHUB_CAPABILITY_PERMISSIONS } =
    await import("@/lib/github/scoped-installation-client");
  assert.deepEqual(
    FLEET_GITHUB_CAPABILITY_PERMISSIONS["github.caller-reconciliation.read"],
    { contents: "read", metadata: "read" },
  );
});
