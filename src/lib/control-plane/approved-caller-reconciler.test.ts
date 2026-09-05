import assert from "node:assert/strict";
import test from "node:test";

import {
  callerReconciliationDigest,
  planApprovedCallerReconciliation,
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
  verifyApprovedBundle: (() => verifiedBundle()) as never,
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
    const plan = await planApprovedCallerReconciliation(
      options,
      client(overrides) as never,
      dependencies,
    );
    assert.equal(plan.verdicts.length, 1, reasonCode);
    assert.equal(plan.verdicts[0]!.state, "SKIPPED", reasonCode);
    assert.equal(plan.verdicts[0]!.reasonCode, reasonCode);
      }
});

test("GitHub 저장소에 결합되지 않은 App은 대상에서 빠진다", async () => {
  const plan = await planApprovedCallerReconciliation(
    options,
    client({ apps: [{ id: "app-1", repoId: null, repoFullName: FULL_NAME, status: "ACTIVE" }] }) as never,
    dependencies,
  );
  assert.deepEqual(plan.verdicts, []);
});

test("적격 저장소는 계약이 caller를 만들 수 있는 입력을 담아 돌려준다", async () => {
  const plan = await planApprovedCallerReconciliation(options, client() as never, dependencies);
  assert.equal(plan.verdicts.length, 1);
  const verdict = plan.verdicts[0]!;
  assert.equal(verdict.state, "ELIGIBLE");
  if (verdict.state !== "ELIGIBLE") return;
  assert.equal(verdict.fullName, FULL_NAME);
  assert.equal(verdict.sourceRef, "refs/heads/main");
  assert.equal(verdict.callerPath, ".github/workflows/org-contract.yml");
  // 계약이 요구하는 provenance가 최상위로 올라와 있어야 한다.
  const manifest = verdict.resolvedManifest as Record<string, unknown>;
  for (const field of [
    "state", "repositoryId", "fullName", "sourceSha", "manifestDigest",
    "configRevisionId", "configRevision", "configRevisionDigest",
    "signedSnapshotDigest", "snapshotSignatureKeyId",
    "snapshotSignaturePolicyRevision", "snapshotSignatureDigest", "manifest",
  ]) {
    assert.ok(field in manifest, field);
  }
  assert.equal(plan.approvedBundle.sourceSha, "a".repeat(40));
  assert.equal(plan.callerPath, ".github/workflows/org-contract.yml");
});

test("매니페스트 구성이 거부하면 그 코드를 이유로 남기고 건너뛴다", async () => {
  const plan = await planApprovedCallerReconciliation(options, client() as never, {
    ...dependencies,
    resolveManifest: (async () => {
      throw new ControlPlaneError("활성 설정 없음", 409, "NO_ACTIVE_CONFIG");
    }) as never,
  });
  assert.equal(plan.verdicts[0]!.state, "SKIPPED");
  assert.equal(plan.verdicts[0]!.reasonCode, "NO_ACTIVE_CONFIG");
});

test("계획 digest는 계약 정규화를 쓴다", () => {
  const digest = callerReconciliationDigest({
    approvedBundle: {
      registryRecordId: "r1",
      sourceSha: "a".repeat(40),
      payloadDigest: `sha256:${"1".repeat(64)}`,
      approvalKeyId: "key-1",
      bundle: {},
    },
    callerPath: ".github/workflows/org-contract.yml",
    verdicts: [{
      state: "SKIPPED",
      reasonCode: "APP_NOT_ACTIVE",
      repositoryId: "1",
      fullName: FULL_NAME,
      callerPath: ".github/workflows/org-contract.yml",
    }],
  });
  assert.ok(digest.startsWith('[{"callerPath"'));
  assert.ok(digest.includes('"state":"SKIPPED"'));
});

test("기본 검증자는 서명되지 않은 번들을 거부한다", async () => {
  // verifyApprovedBundle을 대체하지 않으면 registry의 실제 서명 검증이 돈다.
  await assert.rejects(
    planApprovedCallerReconciliation(options, client() as never, {
      trustedApprovalKeysJson: JSON.stringify({ schemaVersion: 1, keys: [] }),
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
