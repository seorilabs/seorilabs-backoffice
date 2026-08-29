import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import test from "node:test";

import {
  PLATFORM_AFFECTED_CONSUMERS,
  type PlatformConsumerObservationPayload,
} from "@/lib/control-plane/contracts";
import { canonicalJson, type JsonValue } from "@/lib/control-plane/json";
import {
  materializePlatformConsumerObservation,
  producePlatformFleetRelease,
  rawPlatformReleaseManifestSchema,
  verifyPlatformReleaseApproval,
  type PlatformFleetProducerDependencies,
  type RawPlatformReleaseManifest,
} from "@/lib/control-plane/platform-fleet-producer";
import type { recordPlatformRelease, reconcilePlatformFleet } from "@/lib/control-plane/platform-fleet";
import type { recordProviderObservation } from "@/lib/control-plane/service";

const SOURCE_SHA = "1".repeat(40);
const BASE_SHA = "2".repeat(40);
const CONTRACT_REVISION = "3".repeat(64);
const TREE_CHECKSUM = "4".repeat(64);
const WORKFLOW_SHA = "5".repeat(40);

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rawManifest(input: {
  typescriptArtifact: Buffer;
  gdscriptArtifact: Buffer;
  checksumArtifact: Buffer;
}): RawPlatformReleaseManifest {
  return {
    schemaVersion: 1,
    release: { tag: "v1.2.3", sourceSha: SOURCE_SHA, baseSourceSha: BASE_SHA },
    sdk: {
      typescript: {
        package: "@seorilabs/platform-sdk",
        version: "0.9.0",
        registry: "https://npm.pkg.github.com",
        artifact: {
          name: "seorilabs-platform-sdk-0.9.0.tgz",
          sha256: digest(input.typescriptArtifact),
          size: input.typescriptArtifact.length,
        },
      },
      gdscript: {
        version: "1.2.3",
        source: "https://github.com/seorilabs/platform/releases/download/v1.2.3/seorilabs-platform-gdscript-1.2.3.tar.gz",
        treeChecksum: TREE_CHECKSUM,
        artifact: {
          name: "seorilabs-platform-gdscript-1.2.3.tar.gz",
          sha256: digest(input.gdscriptArtifact),
          size: input.gdscriptArtifact.length,
        },
        checksumArtifact: {
          name: "seorilabs-platform-gdscript-1.2.3.tar.gz.sha256",
          sha256: digest(input.checksumArtifact),
          size: input.checksumArtifact.length,
        },
      },
    },
    contract: {
      revision: `sha256:${CONTRACT_REVISION}`,
      baseRevision: `sha256:${CONTRACT_REVISION}`,
      classification: "implementation-only",
      supportedApiMajor: 1,
      affectedConsumers: PLATFORM_AFFECTED_CONSUMERS,
      affectedTracks: ["gdscript"],
      affectedCapabilities: ["core"],
    },
  };
}

function canaryEvidence() {
  const canary = (profile: "godot" | "react-native", index: number) => ({
    profile,
    repositoryId: String(100 + index),
    repositoryFullName: `seorilabs/canary-${profile}`,
    sourceSha: String(6 + index).repeat(40),
    staticRun: {
      runId: String(1000 + index * 2),
      conclusion: "success" as const,
      headSha: String(6 + index).repeat(40),
      workflowSourceSha: WORKFLOW_SHA,
    },
    buildOnlyRun: {
      runId: String(1001 + index * 2),
      conclusion: "success" as const,
      headSha: String(6 + index).repeat(40),
      workflowSourceSha: WORKFLOW_SHA,
      cloudBuildId: `build-${index}`,
      builderImageDigest: `sha256:${String(8 + index).repeat(64)}`,
      buildConfigDigest: `sha256:${String.fromCharCode(97 + index).repeat(64)}`,
      artifact: {
        name: `canary-${index}.aab`,
        sha256: `sha256:${String.fromCharCode(99 + index).repeat(64)}`,
        size: 123 + index,
      },
    },
  });
  return {
    attestationSha256: `sha256:${"a".repeat(64)}`,
    readbackKeyId: "canary-key-1",
    workflowBundle: {
      repository: "seorilabs/.github" as const,
      sourceSha: WORKFLOW_SHA,
      digest: `sha256:${"b".repeat(64)}`,
    },
    canaries: [canary("godot", 0), canary("react-native", 1)],
  };
}

function signedApproval(manifestBytes: Buffer) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const parsed = JSON.parse(manifestBytes.toString("utf8")) as RawPlatformReleaseManifest;
  const payload = {
    purpose: "seorilabs-platform-fleet-approved-release-v2" as const,
    repository: "seorilabs/platform" as const,
    manifestSha256: `sha256:${digest(manifestBytes)}`,
    sourceSha: parsed.release.sourceSha,
    releaseTag: parsed.release.tag,
    status: "fleet-approved" as const,
    canaryEvidence: canaryEvidence(),
  };
  const approval = {
    schemaVersion: 2 as const,
    algorithm: "Ed25519" as const,
    keyId: "release-key-1",
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload as unknown as JsonValue), "utf8"),
      privateKey,
    ).toString("base64"),
  };
  const trustedReleaseKeysJson = JSON.stringify({
    schemaVersion: 1,
    keys: [{
      algorithm: "Ed25519",
      keyId: approval.keyId,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      status: "ACTIVE",
    }],
  });
  return { approval, trustedReleaseKeysJson };
}

function fixtures() {
  const typescriptArtifact = Buffer.from("typescript-sdk", "utf8");
  const gdscriptArtifact = Buffer.from("gdscript-sdk", "utf8");
  const gdscriptName = "seorilabs-platform-gdscript-1.2.3.tar.gz";
  const checksumArtifact = Buffer.from(`${digest(gdscriptArtifact)}  ${gdscriptName}\n`, "utf8");
  const manifest = rawManifest({ typescriptArtifact, gdscriptArtifact, checksumArtifact });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const signed = signedApproval(manifestBytes);
  const approvalBytes = Buffer.from(`${JSON.stringify(signed.approval, null, 2)}\n`, "utf8");
  return {
    manifest,
    manifestBytes,
    approvalBytes,
    trustedReleaseKeysJson: signed.trustedReleaseKeysJson,
    typescriptArtifact,
    gdscriptArtifact,
    checksumArtifact,
  };
}

test("raw manifest byte digest와 Ed25519 fleet approval을 함께 검증한다", () => {
  const value = fixtures();
  const verified = verifyPlatformReleaseApproval(value);
  assert.equal(verified.rawManifestSha256, digest(value.manifestBytes));
  assert.equal(verified.approval.keyId, "release-key-1");

  const tampered = Buffer.concat([value.manifestBytes, Buffer.from(" ", "utf8")]);
  assert.throws(() => verifyPlatformReleaseApproval({
    ...value,
    manifestBytes: tampered,
  }), /raw platform-release\.json과 일치하지 않습니다/);
  assert.throws(() => verifyPlatformReleaseApproval({
    ...value,
    trustedReleaseKeysJson: "",
  }), /trust root/);

  const { privateKey } = generateKeyPairSync("ed25519");
  assert.throws(() => verifyPlatformReleaseApproval({
    ...value,
    trustedReleaseKeysJson: JSON.stringify({
      schemaVersion: 1,
      keys: [{
        algorithm: "Ed25519",
        keyId: "release-key-1",
        publicKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        status: "ACTIVE",
      }],
    }),
  }), /SPKI 공개키만/);
});

test("영향 consumer 선택 계약을 검증하고 v0.6.7 omission만 같은 cohort로 정규화한다", () => {
  const value = fixtures();
  assert.deepEqual(value.manifest.contract.affectedConsumers, PLATFORM_AFFECTED_CONSUMERS);

  const missing = structuredClone(value.manifest) as unknown as Record<string, unknown>;
  delete (missing.contract as Record<string, unknown>).affectedConsumers;
  assert.throws(() => verifyPlatformReleaseApproval({
    ...value,
    manifestBytes: Buffer.from(`${JSON.stringify(missing)}\n`, "utf8"),
  }));

  const legacy = structuredClone(value.manifest) as unknown as Record<string, unknown>;
  const legacySdk = (legacy.sdk as Record<string, unknown>).gdscript as Record<string, unknown>;
  const legacyVersion = "0.6.7";
  const legacyArtifactName = `seorilabs-platform-gdscript-${legacyVersion}.tar.gz`;
  (legacy.release as Record<string, unknown>).tag = `v${legacyVersion}`;
  legacySdk.version = legacyVersion;
  legacySdk.source = `https://github.com/seorilabs/platform/releases/download/v${legacyVersion}/${legacyArtifactName}`;
  (legacySdk.artifact as Record<string, unknown>).name = legacyArtifactName;
  (legacySdk.checksumArtifact as Record<string, unknown>).name = `${legacyArtifactName}.sha256`;
  delete (legacy.contract as Record<string, unknown>).affectedConsumers;
  const legacyBytes = Buffer.from(`${JSON.stringify(legacy)}\n`, "utf8");
  const legacyApproval = signedApproval(legacyBytes);
  const verified = verifyPlatformReleaseApproval({
    manifestBytes: legacyBytes,
    approvalBytes: Buffer.from(`${JSON.stringify(legacyApproval.approval)}\n`, "utf8"),
    trustedReleaseKeysJson: legacyApproval.trustedReleaseKeysJson,
  });
  assert.deepEqual(verified.manifest.contract.affectedConsumers, PLATFORM_AFFECTED_CONSUMERS);

  for (const version of ["0.6.6", "0.6.8"]) {
    const unsupportedOmission = structuredClone(value.manifest) as unknown as Record<string, unknown>;
    const sdk = (unsupportedOmission.sdk as Record<string, unknown>).gdscript as Record<string, unknown>;
    const artifactName = `seorilabs-platform-gdscript-${version}.tar.gz`;
    (unsupportedOmission.release as Record<string, unknown>).tag = `v${version}`;
    sdk.version = version;
    sdk.source = `https://github.com/seorilabs/platform/releases/download/v${version}/${artifactName}`;
    (sdk.artifact as Record<string, unknown>).name = artifactName;
    (sdk.checksumArtifact as Record<string, unknown>).name = `${artifactName}.sha256`;
    delete (unsupportedOmission.contract as Record<string, unknown>).affectedConsumers;
    assert.equal(rawPlatformReleaseManifestSchema.safeParse(unsupportedOmission).success, false);
  }

  const invalid = structuredClone(value.manifest) as unknown as Record<string, unknown>;
  (invalid.contract as Record<string, unknown>).affectedConsumers = {
    cohort: "repository-file-list",
    resolution: "release-time",
  };
  assert.throws(() => verifyPlatformReleaseApproval({
    ...value,
    manifestBytes: Buffer.from(`${JSON.stringify(invalid)}\n`, "utf8"),
  }));
});

test("exact dependency evidence는 현재 artifact integrity가 맞을 때만 compliant digest를 얻는다", () => {
  const value = fixtures();
  const discovery: PlatformConsumerObservationPayload = {
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    integration: "SDK",
    artifactKind: "TYPESCRIPT",
    observedVersion: value.manifest.sdk.typescript.version,
    observedDigest: null,
    contractRevision: null,
    evidenceDigest: "d".repeat(64),
    lockIntegrity: `sha512-${createHash("sha512").update("other-artifact").digest("base64")}`,
  };
  const valid = materializePlatformConsumerObservation({
    discovery: {
      ...discovery,
      lockIntegrity: `sha512-${createHash("sha512").update(value.typescriptArtifact).digest("base64")}`,
    },
    raw: value.manifest,
    typescriptArtifact: value.typescriptArtifact,
  });
  assert.equal(valid.integration, "SDK");
  if (valid.integration !== "SDK") return;
  assert.equal(valid.observedDigest, value.manifest.sdk.typescript.artifact.sha256);
  assert.equal(valid.contractRevision, CONTRACT_REVISION);

  const mismatch = materializePlatformConsumerObservation({
    discovery,
    raw: value.manifest,
    typescriptArtifact: value.typescriptArtifact,
  });
  assert.equal(mismatch.integration, "CUSTOM_HTTP");
  assert.equal(materializePlatformConsumerObservation({
    discovery: { ...discovery, lockIntegrity: valid.lockIntegrity },
    raw: value.manifest,
  }).integration, "CUSTOM_HTTP");
});

test("GDScript는 fixed release URL과 실제 tree checksum이 모두 맞아야 digest를 얻는다", () => {
  const value = fixtures();
  const discovery: PlatformConsumerObservationPayload = {
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    integration: "SDK",
    artifactKind: "GDSCRIPT",
    observedVersion: value.manifest.sdk.gdscript.version,
    observedDigest: null,
    contractRevision: null,
    evidenceDigest: "e".repeat(64),
    releaseAssetUrl: value.manifest.sdk.gdscript.source,
    treeChecksum: value.manifest.sdk.gdscript.treeChecksum,
  };
  const valid = materializePlatformConsumerObservation({
    discovery,
    raw: value.manifest,
  });
  assert.equal(valid.integration, "SDK");
  if (valid.integration !== "SDK") return;
  assert.equal(valid.observedDigest, value.manifest.sdk.gdscript.artifact.sha256);
  assert.equal(valid.contractRevision, CONTRACT_REVISION);

  const mismatch = materializePlatformConsumerObservation({
    discovery: { ...discovery, treeChecksum: "f".repeat(64) },
    raw: value.manifest,
  });
  assert.equal(mismatch.integration, "CUSTOM_HTTP");
});

test("approval asset이 없으면 DB cohort와 mutation 경계를 호출하지 않는다", async () => {
  const value = fixtures();
  const manifestAsset = {
    id: 10,
    name: "platform-release.json",
    size: value.manifestBytes.length,
    digest: `sha256:${digest(value.manifestBytes)}`,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
  const dependencies = {
    latestRelease: async () => ({
      id: 99,
      tagName: "v1.2.3",
      tagSourceSha: SOURCE_SHA,
      publishedAt: "2026-08-28T00:00:00.000Z",
      draft: false,
      prerelease: false,
      assets: [manifestAsset],
    }),
    readAsset: async () => value.manifestBytes,
    listConsumers: async () => assert.fail("approval 이전에는 cohort를 읽으면 안 됩니다."),
    recordObservation: async () => assert.fail("approval 이전에는 observation을 쓰면 안 됩니다."),
    recordRelease: async () => assert.fail("approval 이전에는 release를 쓰면 안 됩니다."),
    reconcile: async () => assert.fail("approval 이전에는 reconcile하면 안 됩니다."),
    signingKey: "internal-signing-key",
    trustedReleaseKeysJson: "",
  } as unknown as PlatformFleetProducerDependencies;
  const result = await producePlatformFleetRelease(dependencies);
  assert.equal(result.status, "WAITING_APPROVAL");
  assert.equal(result.recorded, 0);
  assert.equal(result.reconciled, false);
});

test("승인 release는 observation, append-only record, reconcile을 같은 exact input으로 멱등 연결한다", async () => {
  const value = fixtures();
  const bytesByName = new Map<string, Buffer>([
    ["platform-release.json", value.manifestBytes],
    ["fleet-approved.json", value.approvalBytes],
    [value.manifest.sdk.typescript.artifact.name, value.typescriptArtifact],
    [value.manifest.sdk.gdscript.artifact.name, value.gdscriptArtifact],
    [value.manifest.sdk.gdscript.checksumArtifact.name, value.checksumArtifact],
  ]);
  const assets = [...bytesByName].map(([name, bytes], index) => ({
    id: index + 1,
    name,
    size: bytes.length,
    digest: `sha256:${digest(bytes)}`,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  }));
  const lockIntegrity = `sha512-${createHash("sha512").update(value.typescriptArtifact).digest("base64")}`;
  let recordedManifest: unknown;
  let recordedObservation: unknown;
  let reconcileInput: unknown;
  const dependencies: PlatformFleetProducerDependencies = {
    latestRelease: async () => ({
      id: 99,
      tagName: "v1.2.3",
      tagSourceSha: SOURCE_SHA,
      publishedAt: "2026-08-28T00:00:00.000Z",
      draft: false,
      prerelease: false,
      assets,
    }),
    readAsset: async (asset) => bytesByName.get(asset.name)!,
    listConsumers: async () => [{
      repoId: 42n,
      repoFullName: "seorilabs/sample-app",
      engine: "RN",
      sourceSha: SOURCE_SHA,
      discoveryObservationId: "discovery-1",
      discoveryObservedAt: new Date("2026-08-28T00:00:00.000Z"),
      platformConsumer: {
        schemaVersion: 1,
        sourceSha: SOURCE_SHA,
        integration: "SDK",
        artifactKind: "TYPESCRIPT",
        observedVersion: "0.9.0",
        observedDigest: null,
        contractRevision: null,
        evidenceDigest: "d".repeat(64),
        lockIntegrity,
      },
    }],
    recordObservation: (async (input: Parameters<typeof recordProviderObservation>[0]) => {
      recordedObservation = input;
      return { observation: { id: "provider-1" }, duplicate: false };
    }) as unknown as typeof recordProviderObservation,
    recordRelease: (async (input: Parameters<typeof recordPlatformRelease>[0]) => {
      recordedManifest = input.manifest;
      return { release: { id: "release-1" }, duplicate: false };
    }) as unknown as typeof recordPlatformRelease,
    reconcile: (async (input: Parameters<typeof reconcilePlatformFleet>[0]) => {
      reconcileInput = input;
      return { duplicate: false };
    }) as unknown as typeof reconcilePlatformFleet,
    signingKey: "internal-signing-key",
    trustedReleaseKeysJson: value.trustedReleaseKeysJson,
  };
  const result = await producePlatformFleetRelease(dependencies);
  assert.equal(result.status, "RECONCILED");
  assert.equal(result.recorded, 1);
  assert.equal((recordedManifest as { provenance?: { releaseId: string } }).provenance?.releaseId, "99");
  assert.deepEqual(
    (recordedManifest as { canaryEvidence?: unknown }).canaryEvidence,
    canaryEvidence(),
  );
  assert.deepEqual(
    (recordedManifest as { affectedConsumers?: unknown }).affectedConsumers,
    PLATFORM_AFFECTED_CONSUMERS,
  );
  assert.equal("consumers" in (recordedManifest as object), false);
  assert.equal(
    (recordedObservation as { payload: PlatformConsumerObservationPayload }).payload.integration,
    "SDK",
  );
  assert.deepEqual(
    (reconcileInput as { consumers: unknown[] }).consumers,
    [{ repoId: "42", discoveryObservationId: "discovery-1", providerObservationId: "provider-1" }],
  );

  await assert.rejects(producePlatformFleetRelease({
    ...dependencies,
    latestRelease: async () => ({
      id: 99,
      tagName: "v1.2.3",
      tagSourceSha: SOURCE_SHA,
      publishedAt: "2026-08-28T00:00:00.000Z",
      draft: false,
      prerelease: false,
      assets: assets.filter((asset) => asset.name !== value.manifest.sdk.typescript.artifact.name),
    }),
  }), (error) => (
    (error as { code?: unknown }).code === "PLATFORM_RELEASE_ASSET_IDENTITY_INVALID"
  ));
});
