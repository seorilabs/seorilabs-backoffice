import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import test from "node:test";
import { strToU8, zipSync } from "fflate";

import { contractCanonicalJson, type JsonValue } from "@/lib/control-plane/json";
import { ControlPlaneError } from "@/lib/control-plane/service";
import {
  importWorkflowBundleApproval,
  readWorkflowBundleRegistryRecords,
  importWorkflowBundleCandidate,
  verifyWorkflowBundleRegistryReadback,
} from "@/lib/control-plane/workflow-bundle-v5-registry";

const BUNDLE_SHA = "c".repeat(40);

function digest(value: string | Buffer | JsonValue): string {
  const bytes = typeof value === "string" || Buffer.isBuffer(value)
    ? value
    : contractCanonicalJson(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function candidateBundle() {
  const payload = {
    schemaVersion: 2,
    bundleVersion: "5.0.0",
    source: {
      repository: "seorilabs/.github",
      sha: BUNDLE_SHA,
      workflowExecutionSha: BUNDLE_SHA,
    },
    quality: {
      contractDigests: { "contracts/workflow-bundle-v5.schema.json": `sha256:${"1".repeat(64)}` },
      runtimeAssetDigests: {
        ".github/cloud-build/rn-android-build-only-v2.yaml": `sha256:${"2".repeat(64)}`,
        ".github/cloud-build/godot-android-build-only-v2.yaml": `sha256:${"3".repeat(64)}`,
      },
    },
    promotionScope: {
      staticProfiles: ["react-native", "godot", "capacitor", "ait-web"],
      buildProfiles: ["react-native-android", "godot-android"],
    },
    staticRuntimeBinding: {},
    buildRuntimeBinding: {},
    staticProfiles: {
      "react-native": { path: ".github/workflows/js-static-checks-v1.yml", runtime: "react-native", sha: BUNDLE_SHA },
      godot: { path: ".github/workflows/godot-checks-v3.yml", runtime: "godot", sha: BUNDLE_SHA },
      capacitor: { path: ".github/workflows/js-static-checks-v1.yml", runtime: "capacitor", sha: BUNDLE_SHA },
      "ait-web": { path: ".github/workflows/js-static-checks-v1.yml", runtime: "ait-web", sha: BUNDLE_SHA },
    },
    buildProfiles: {
      "react-native-android": {
        target: "android",
        executor: "cloud-build-x64",
        workflow: ".github/workflows/rn-build-android-cloud-v2.yml",
        artifactKind: "android-aab",
        scriptPath: "scripts/build-android.sh",
        builderImage: `builder/rn@sha256:${"4".repeat(64)}`,
        sha: BUNDLE_SHA,
      },
      "godot-android": {
        target: "android",
        executor: "cloud-build-x64",
        workflow: ".github/workflows/godot-build-android-cloud-v2.yml",
        artifactKind: "android-aab",
        scriptPath: "scripts/build-android.sh",
        builderImage: `builder/godot@sha256:${"5".repeat(64)}`,
        sha: BUNDLE_SHA,
      },
    },
    actions: {},
    runners: {},
    toolchains: {},
    callerPolicies: {},
    lifecyclePolicy: {},
    approval: { state: "CANDIDATE", evidence: [] },
  };
  return {
    ...payload,
    integrity: { algorithm: "sha256", payloadDigest: digest(payload as JsonValue) },
  };
}

function evidence(candidate: ReturnType<typeof candidateBundle>) {
  const candidateDigest = (candidate.integrity as { payloadDigest: string }).payloadDigest;
  const common = (index: number) => ({
    schemaVersion: 2,
    repositoryId: 7000 + index,
    fullName: `seorilabs/static-${index}`,
    sourceSha: `${index}`.repeat(40),
    workflowExecutionSha: BUNDLE_SHA,
    workflowRef: `seorilabs/.github/.github/workflows/js-static-checks-v1.yml@${BUNDLE_SHA}`,
    runId: 1000 + index,
    runAttempt: 1,
    configRevisionId: `config-static-${index}`,
    configRevision: 1,
    configRevisionDigest: `sha256:${"6".repeat(64)}`,
    signedSnapshotDigest: `sha256:${"7".repeat(64)}`,
    snapshotSignatureKeyId: "snapshot-key-v1",
    snapshotSignaturePolicyRevision: "snapshot-policy-v1",
    snapshotSignatureDigest: `sha256:${"8".repeat(64)}`,
    artifactSha256: `sha256:${"9".repeat(64)}`,
  });
  // 필수 증거는 번들이 선언한 promotionScope에서 파생된다. fixture도 같은 값을 쓴다.
  const staticProfiles = candidate.promotionScope.staticProfiles;
  const staticRecords = staticProfiles.map((profile, index) => ({
    ...common(index + 1),
    target: "static",
    profile,
    bindingSourceSha: `${index + 1}`.repeat(40),
    callerWorkflowRef: `seorilabs/static-${index + 1}/.github/workflows/org-contract.yml@refs/heads/main`,
    manifestDigest: `sha256:${"a".repeat(64)}`,
    workflowRef: `seorilabs/.github/${profile === "godot"
      ? ".github/workflows/godot-checks-v3.yml"
      : ".github/workflows/js-static-checks-v1.yml"}@${BUNDLE_SHA}`,
  }));
  const buildRecords = [
    {
      repositoryId: 1250442131,
      fullName: "seorilabs/happy-farm",
      buildProfile: "react-native-android",
      workflow: ".github/workflows/rn-build-android-cloud-v2.yml",
      builderImage: `builder/rn@sha256:${"4".repeat(64)}`,
      cloudBuildConfigSha256: `sha256:${"2".repeat(64)}`,
    },
    {
      repositoryId: 1265192029,
      fullName: "seorilabs/lizard-tycoon",
      buildProfile: "godot-android",
      workflow: ".github/workflows/godot-build-android-cloud-v2.yml",
      builderImage: `builder/godot@sha256:${"5".repeat(64)}`,
      cloudBuildConfigSha256: `sha256:${"3".repeat(64)}`,
    },
  ].map((record, index) => ({
    ...common(index + 5),
    target: "build",
    repositoryId: record.repositoryId,
    fullName: record.fullName,
    sourceSha: `${index + 5}`.repeat(40),
    bindingSourceSha: `${index + 5}`.repeat(40),
    callerWorkflowRef: `${record.fullName}/.github/workflows/android-build-only.yml@refs/pull/${index + 41}/merge`,
    manifestDigest: `sha256:${"b".repeat(64)}`,
    bundlePayloadDigest: candidateDigest,
    workflowRef: `seorilabs/.github/${record.workflow}@${BUNDLE_SHA}`,
    buildProfile: record.buildProfile,
    cloudBuildId: `${index + 1}1111111-1111-4111-8111-111111111111`,
    builderImage: record.builderImage,
    cloudBuildConfigSha256: record.cloudBuildConfigSha256,
    marketUpload: false,
  }));
  return [...staticRecords, ...buildRecords];
}

function approvedFixture(
  mutate?: (candidate: ReturnType<typeof candidateBundle>) => void,
  // 증거를 서명 전에 바꿔야 서명은 유효하면서 집합만 어긋난 번들을 만들 수 있다.
  mutateRecords?: (records: ReturnType<typeof evidence>) => ReturnType<typeof evidence>,
) {
  const candidate = candidateBundle();
  mutate?.(candidate);
  const records = mutateRecords ? mutateRecords(evidence(candidate)) : evidence(candidate);
  const contractDigests = (candidate.quality as { contractDigests: JsonValue }).contractDigests;
  const runtimeAssetDigests = (candidate.quality as { runtimeAssetDigests: JsonValue }).runtimeAssetDigests;
  const candidateDigest = (candidate.integrity as { payloadDigest: string }).payloadDigest;
  const envelope = {
    schemaVersion: 1,
    kind: "WORKFLOW_BUNDLE_V5_APPROVAL",
    registryId: "seorilabs-workflow-bundles-v5",
    subject: `workflow-bundle-v5:${BUNDLE_SHA}`,
    bundleVersion: "5.0.0",
    source: candidate.source,
    candidateDigest,
    evidenceDigest: digest(records as unknown as JsonValue),
    contractDigestsDigest: digest(contractDigests),
    runtimeAssetDigestsDigest: digest(runtimeAssetDigests),
  } as JsonValue;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signature = sign(null, Buffer.from(contractCanonicalJson(envelope), "utf8"), privateKey).toString("base64url");
  const candidatePayload = { ...candidate } as Record<string, JsonValue>;
  delete candidatePayload.integrity;
  const approvedPayload = {
    ...candidatePayload,
    approval: {
      state: "APPROVED",
      evidence: records,
      signature: {
        algorithm: "Ed25519",
        keyId: "workflow-bundle-v5-test",
        policyRevision: "workflow-bundle-policy-v5",
        value: signature,
      },
    },
  } as JsonValue;
  const approved = {
    ...approvedPayload as Record<string, JsonValue>,
    integrity: { algorithm: "sha256", payloadDigest: digest(approvedPayload) },
  };
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  const fingerprint = digest(publicKey.export({ type: "spki", format: "der" }));
  const trustedKeysJson = JSON.stringify({
    schemaVersion: 1,
    keys: [{
      algorithm: "Ed25519",
      keyId: "workflow-bundle-v5-test",
      policyRevision: "workflow-bundle-policy-v5",
      publicKeyPem,
      fingerprint,
      status: "ACTIVE",
    }],
  });
  return { candidate, approved, envelope, trustedKeysJson };
}

function archive(bundle: ReturnType<typeof candidateBundle>): Buffer {
  return Buffer.from(zipSync({
    "workflow-bundle-v5.json": strToU8(`${JSON.stringify(bundle)}\n`),
  }));
}

function memoryClient(seed: Array<Record<string, unknown>> = []) {
  const rows = [...seed];
  const audits: unknown[] = [];
  const recordApi = {
    async findUnique({ where }: { where: { idempotencyKey: string } }) {
      return rows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null;
    },
    async findFirst({ where }: { where: Record<string, unknown> }) {
      return rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null;
    },
    async create({ data }: { data: Record<string, unknown> }) {
      const row = {
        id: `registry-${rows.length + 1}`,
        createdAt: new Date(),
        candidateDigest: null,
        evidenceDigest: null,
        approvalPayloadDigest: null,
        approvalKeyId: null,
        approvalPolicyRevision: null,
        artifactRepository: null,
        artifactRepositoryId: null,
        artifactWorkflowPath: null,
        artifactRunId: null,
        artifactRunAttempt: null,
        artifactId: null,
        artifactName: null,
        artifactDigest: null,
        approvalSlot: null,
        ...data,
      };
      rows.push(row);
      return row;
    },
  };
  return {
    rows,
    audits,
    workflowBundleRegistryRecord: recordApi,
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback({
        workflowBundleRegistryRecord: recordApi,
        auditLog: { async create(input: unknown) { audits.push(input); return {}; } },
      });
    },
  };
}

test("필수 증거 집합은 번들이 선언한 promotion scope에서 파생된다", () => {
  const narrowed = candidateBundle();
  narrowed.promotionScope = {
    staticProfiles: ["react-native", "godot", "capacitor"],
    buildProfiles: ["react-native-android", "godot-android"],
  };
  const records = evidence(narrowed);
  assert.equal(records.length, 5);
  assert.deepEqual(
    records.map((record) => (record.target === "static"
      ? `static:${(record as { profile: string }).profile}`
      : `build:${(record as { buildProfile: string }).buildProfile}`)).sort(),
    [
      "build:godot-android",
      "build:react-native-android",
      "static:capacitor",
      "static:godot",
      "static:react-native",
    ],
  );
  assert.ok(!records.some((record) => (record as { profile?: string }).profile === "ait-web"));
});

test("candidate import는 exact successful GitHub artifact와 bundle integrity를 durable record로 만든다", async () => {
  const candidate = candidateBundle();
  const bytes = archive(candidate);
  const client = memoryClient();
  const result = await importWorkflowBundleCandidate({
    sourceSha: BUNDLE_SHA,
    runId: 33240997396n,
    runAttempt: 1,
    artifactId: 9711367292n,
    idempotencyKey: "candidate-import:exact",
    actor: "test:registry-importer",
  }, client as never, {
    trustedApprovalKeysJson: "",
    async readCandidateArtifact() {
      return {
        repository: "seorilabs/.github",
        repositoryId: "1241442018",
        sourceSha: BUNDLE_SHA,
        workflowPath: ".github/workflows/workflow-bundle-v5-candidate.yml",
        eventName: "push",
        headBranch: "main",
        runId: 33240997396n,
        runAttempt: 1,
        runStatus: "completed",
        runConclusion: "success",
        artifactId: 9711367292n,
        artifactName: `workflow-bundle-v5-candidate-${BUNDLE_SHA}`,
        artifactDigest: digest(bytes),
        artifactExpired: false,
        artifactWorkflowRunId: 33240997396n,
        artifactWorkflowRepositoryId: "1241442018",
        artifactWorkflowHeadSha: BUNDLE_SHA,
        archive: bytes,
      };
    },
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.record.approvalState, "CANDIDATE");
  assert.equal(result.record.payloadDigest, (candidate.integrity as { payloadDigest: string }).payloadDigest);
  assert.equal(client.rows.length, 1);
});

test("candidate import는 artifact 검증 후 원장 transaction에서 claim을 확인하고 소유권을 잃으면 쓰지 않는다", async () => {
  for (const claimAlive of [true, false]) {
    const bytes = archive(candidateBundle());
    const client = memoryClient();
    let artifactRead = false;
    let claimChecks = 0;
    const imported = importWorkflowBundleCandidate({
      sourceSha: BUNDLE_SHA,
      runId: 1n,
      runAttempt: 1,
      artifactId: 2n,
      idempotencyKey: `candidate-import:claim:${claimAlive}`,
      actor: "test:registry-importer",
      async assertWriteAllowed(tx) {
        assert.equal(artifactRead, true);
        assert.equal(tx.workflowBundleRegistryRecord, client.workflowBundleRegistryRecord);
        assert.equal(client.rows.length, 0);
        assert.equal(client.audits.length, 0);
        claimChecks += 1;
        if (!claimAlive) throw new Error("claim lost");
      },
    }, client as never, {
      trustedApprovalKeysJson: "",
      async readCandidateArtifact() {
        artifactRead = true;
        return {
          repository: "seorilabs/.github",
          repositoryId: "1241442018",
          sourceSha: BUNDLE_SHA,
          workflowPath: ".github/workflows/workflow-bundle-v5-candidate.yml",
          eventName: "push",
          headBranch: "main",
          runId: 1n,
          runAttempt: 1,
          runStatus: "completed",
          runConclusion: "success",
          artifactId: 2n,
          artifactName: `workflow-bundle-v5-candidate-${BUNDLE_SHA}`,
          artifactDigest: digest(bytes),
          artifactExpired: false,
          artifactWorkflowRunId: 1n,
          artifactWorkflowRepositoryId: "1241442018",
          artifactWorkflowHeadSha: BUNDLE_SHA,
          archive: bytes,
        };
      },
    });
    if (claimAlive) await imported;
    else await assert.rejects(imported, { message: "claim lost" });
    assert.equal(claimChecks, 1);
    assert.equal(client.rows.length, claimAlive ? 1 : 0);
    assert.equal(client.audits.length, claimAlive ? 1 : 0);
  }
});

test("candidate import는 look-alike repo, 실패 run과 artifact digest drift를 거부한다", async () => {
  const candidate = candidateBundle();
  const bytes = archive(candidate);
  for (const override of [
    { repository: "attacker/.github" },
    { runConclusion: "failure" },
    { artifactDigest: `sha256:${"f".repeat(64)}` },
  ]) {
    await assert.rejects(
      importWorkflowBundleCandidate({
        sourceSha: BUNDLE_SHA,
        runId: 1n,
        runAttempt: 1,
        artifactId: 2n,
        idempotencyKey: `candidate-import:${Object.keys(override)[0]}`,
        actor: "test",
      }, memoryClient() as never, {
        trustedApprovalKeysJson: "",
        async readCandidateArtifact() {
          return {
            repository: "seorilabs/.github",
            repositoryId: "1241442018",
            sourceSha: BUNDLE_SHA,
            workflowPath: ".github/workflows/workflow-bundle-v5-candidate.yml",
            eventName: "push",
            headBranch: "main",
            runId: 1n,
            runAttempt: 1,
            runStatus: "completed",
            runConclusion: "success",
            artifactId: 2n,
            artifactName: `workflow-bundle-v5-candidate-${BUNDLE_SHA}`,
            artifactDigest: digest(bytes),
            artifactExpired: false,
            artifactWorkflowRunId: 1n,
            artifactWorkflowRepositoryId: "1241442018",
            artifactWorkflowHeadSha: BUNDLE_SHA,
            archive: bytes,
            ...override,
          };
        },
      }),
      (error) => error instanceof ControlPlaneError
        && error.code === "WORKFLOW_BUNDLE_CANDIDATE_UNTRUSTED",
    );
  }
});

test("APPROVED import와 runtime readback은 candidate artifact, canonical Ed25519, key fingerprint를 모두 요구한다", async () => {
  const fixture = approvedFixture();
  const candidateDigest = (fixture.candidate.integrity as { payloadDigest: string }).payloadDigest;
  const candidateRow = {
    id: "candidate-1",
    registryId: "seorilabs-workflow-bundles-v5",
    subject: `workflow-bundle-v5:${BUNDLE_SHA}`,
    approvalState: "CANDIDATE",
    sourceSha: BUNDLE_SHA,
    workflowExecutionSha: BUNDLE_SHA,
    bundleVersion: "5.0.0",
    payloadDigest: candidateDigest,
    candidateDigest: null,
    contractDigestsDigest: (fixture.envelope as Record<string, string>).contractDigestsDigest,
    runtimeAssetDigestsDigest: (fixture.envelope as Record<string, string>).runtimeAssetDigestsDigest,
    evidenceDigest: null,
    approvalPayloadDigest: null,
    approvalKeyId: null,
    approvalPolicyRevision: null,
    bundle: fixture.candidate,
    artifactRepository: "seorilabs/.github",
    artifactWorkflowPath: ".github/workflows/workflow-bundle-v5-candidate.yml",
    artifactRunId: 1n,
    artifactId: 2n,
    artifactDigest: `sha256:${"d".repeat(64)}`,
    requestHash: "e".repeat(64),
    idempotencyKey: "candidate:seed",
    createdAt: new Date(),
  };
  const client = memoryClient([candidateRow]);
  const result = await importWorkflowBundleApproval({
    bundle: fixture.approved,
    idempotencyKey: "approved-import:exact",
    actor: "test:registry-publisher",
  }, client as never, {
    trustedApprovalKeysJson: fixture.trustedKeysJson,
    async readCandidateArtifact() { throw new Error("not used"); },
  });
  assert.equal(result.record.approvalState, "APPROVED");
  assert.equal(result.record.candidateDigest, candidateDigest);
  assert.doesNotThrow(() => verifyWorkflowBundleRegistryReadback(
    result.record as never,
    fixture.trustedKeysJson,
  ));

  const tampered = structuredClone(result.record) as typeof result.record;
  tampered.approvalPayloadDigest = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => verifyWorkflowBundleRegistryReadback(tampered as never, fixture.trustedKeysJson),
    (error) => error instanceof ControlPlaneError
      && error.code === "WORKFLOW_BUNDLE_REGISTRY_PROVENANCE_INVALID",
  );
});

const NARROWED_SCOPE = (candidate: ReturnType<typeof candidateBundle>) => {
  candidate.promotionScope = {
    staticProfiles: ["react-native", "godot", "capacitor"],
    buildProfiles: ["react-native-android", "godot-android"],
  };
};

async function rejectsApproval(
  fixture: ReturnType<typeof approvedFixture>,
  key: string,
  code: string,
) {
  await assert.rejects(
    importWorkflowBundleApproval({
      bundle: fixture.approved,
      idempotencyKey: key,
      actor: "test",
    }, memoryClient() as never, {
      trustedApprovalKeysJson: fixture.trustedKeysJson,
      async readCandidateArtifact() { throw new Error("not used"); },
    }),
    (error) => error instanceof ControlPlaneError && error.code === code,
  );
}

test("승인 증거 집합이 번들의 promotion scope와 어긋나면 서명이 유효해도 거부된다", async () => {
  // ait-web을 뺀 범위에서는 증거가 정확히 다섯이다.
  const exact = approvedFixture(NARROWED_SCOPE);
  assert.equal(
    ((exact.approved as Record<string, unknown>).approval as { evidence: unknown[] }).evidence.length,
    5,
  );

  const dropped = approvedFixture(NARROWED_SCOPE, (records) => records.slice(0, 4));
  await rejectsApproval(dropped, "approved-import:missing-evidence", "WORKFLOW_BUNDLE_EVIDENCE_INVALID");

  const extra = approvedFixture(NARROWED_SCOPE, (records) => [
    ...records,
    { ...structuredClone(records[0]!), profile: "ait-web" },
  ]);
  await rejectsApproval(extra, "approved-import:extra-evidence", "WORKFLOW_BUNDLE_EVIDENCE_INVALID");
});

test("promotion scope가 비면 스키마 단계에서 거부된다", async () => {
  // buildProfiles는 두 literal의 tuple이라 빈 범위는 증거 검사에 닿기 전에 막힌다.
  const empty = approvedFixture((candidate) => {
    candidate.promotionScope = { staticProfiles: [], buildProfiles: [] } as never;
  });
  await assert.rejects(importWorkflowBundleApproval({
    bundle: empty.approved,
    idempotencyKey: "approved-import:empty-scope",
    actor: "test",
  }, memoryClient() as never, {
    trustedApprovalKeysJson: empty.trustedKeysJson,
    async readCandidateArtifact() { throw new Error("not used"); },
  }));
});

test("번들에 canary Cloud Build 설정이 없으면 어떤 자산이 빠졌는지 밝히며 거부한다", async () => {
  const fixture = approvedFixture((candidate) => {
    const digests = (candidate.quality as { runtimeAssetDigests: Record<string, string> })
      .runtimeAssetDigests;
    delete digests[".github/cloud-build/rn-android-build-only-v2.yaml"];
  });
  await assert.rejects(
    importWorkflowBundleApproval({
      bundle: fixture.approved,
      idempotencyKey: "approved-import:missing-cloud-build-config",
      actor: "test",
    }, memoryClient() as never, {
      trustedApprovalKeysJson: fixture.trustedKeysJson,
      async readCandidateArtifact() { throw new Error("not used"); },
    }),
    (error) => error instanceof ControlPlaneError
      && error.code === "WORKFLOW_BUNDLE_EVIDENCE_INVALID"
      && error.message.includes("rn-android-build-only-v2.yaml"),
  );
});

test("registry readback은 이 registry의 기록만 최신순으로 돌려준다", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    workflowBundleRegistryRecord: {
      async findMany(args: Record<string, unknown>) {
        calls.push(args);
        return [{ id: "record-1" }];
      },
    },
  };

  await readWorkflowBundleRegistryRecords("a".repeat(40), client as never);
  assert.deepEqual(calls[0], {
    where: { registryId: "seorilabs-workflow-bundles-v5", sourceSha: "a".repeat(40) },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  await readWorkflowBundleRegistryRecords(null, client as never);
  assert.deepEqual((calls[1] as { where: unknown }).where, {
    registryId: "seorilabs-workflow-bundles-v5",
  });
});

test("서명자가 유효해도 build evidence의 candidate digest나 market gate가 다르면 승인되지 않는다", async () => {
  const fixture = approvedFixture();
  const altered = structuredClone(fixture.approved) as Record<string, unknown>;
  const approval = altered.approval as { evidence: Array<Record<string, unknown>> };
  const build = approval.evidence.find((record) => record.target === "build")!;
  build.bundlePayloadDigest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(
    importWorkflowBundleApproval({
      bundle: altered,
      idempotencyKey: "approved-import:bad-evidence",
      actor: "test",
    }, memoryClient() as never, {
      trustedApprovalKeysJson: fixture.trustedKeysJson,
      async readCandidateArtifact() { throw new Error("not used"); },
    }),
    (error) => error instanceof ControlPlaneError
      && ["WORKFLOW_BUNDLE_INTEGRITY_INVALID", "WORKFLOW_BUNDLE_EVIDENCE_INVALID"].includes(error.code),
  );
});
