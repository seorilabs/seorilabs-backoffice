import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  PLATFORM_AFFECTED_CONSUMERS,
  parseStoredPlatformReleaseManifest,
  platformFleetTaskInputSchema,
  platformReleaseManifestSchema,
  type PlatformReleaseManifest,
} from "@/lib/control-plane/contracts";
import { platformFleetDisposition } from "@/lib/control-plane/platform-fleet-policy";

const sourceSha = "1".repeat(40);
const releaseSourceSha = "2".repeat(40);
const artifactDigest = "a".repeat(64);
const contractRevision = "b".repeat(64);
const manifestDigest = "c".repeat(64);
const canaryEvidence: PlatformReleaseManifest["canaryEvidence"] = {
  attestationSha256: `sha256:${"d".repeat(64)}`,
  readbackKeyId: "test-readback-key",
  workflowBundle: {
    repository: "seorilabs/.github",
    sourceSha: releaseSourceSha,
    digest: `sha256:${"e".repeat(64)}`,
  },
  canaries: ["godot", "react-native"].map((profile, index) => ({
    profile: profile as "godot" | "react-native",
    repositoryId: String(9001 + index),
    repositoryFullName: `seorilabs/${profile}-canary`,
    sourceSha,
    staticRun: { runId: String(100 + index * 2), conclusion: "success" as const, headSha: sourceSha, workflowSourceSha: releaseSourceSha },
    buildOnlyRun: {
      runId: String(101 + index * 2), conclusion: "success" as const, headSha: sourceSha, workflowSourceSha: releaseSourceSha,
      cloudBuildId: `build-${index}`, builderImageDigest: `sha256:${"f".repeat(64)}`,
      buildConfigDigest: `sha256:${"0".repeat(64)}`,
      artifact: { name: `${profile}.aab`, sha256: `sha256:${"1".repeat(64)}`, size: 1 },
    },
  })) as PlatformReleaseManifest["canaryEvidence"]["canaries"],
};

function manifest(
  classification: PlatformReleaseManifest["classification"] = "IMPLEMENTATION_ONLY",
): PlatformReleaseManifest {
  return {
    schemaVersion: 1,
    approval: "FLEET_APPROVED",
    version: "1.2.3",
    sourceSha: releaseSourceSha,
    contractRevision,
    classification,
    affectedConsumers: PLATFORM_AFFECTED_CONSUMERS,
    publishedAt: "2026-08-28T00:00:00.000Z",
    artifacts: [{
      kind: "TYPESCRIPT",
      version: "1.2.3",
      digest: artifactDigest,
      packageName: "@seorilabs/platform",
    }],
    canaryEvidence,
    provenance: {
      repository: "seorilabs/platform",
      releaseId: "77",
      releaseTag: "v1.2.3",
      rawManifestSha256: "2".repeat(64),
      approvalSha256: "3".repeat(64),
      approvalKeyId: "test-approval-key",
    },
  };
}

test("Platform release 계약은 승인, provenance, canary, exact artifact만 불변 원장에 허용한다", () => {
  assert.deepEqual(PLATFORM_AFFECTED_CONSUMERS, {
    cohort: "backoffice-managed-product-apps",
    resolution: "reconcile-time",
  });
  assert.deepEqual(platformReleaseManifestSchema.parse(manifest()), manifest());
  assert.equal(platformReleaseManifestSchema.safeParse({
    ...manifest(),
    approval: "DRAFT",
  }).success, false);
  assert.equal(platformReleaseManifestSchema.safeParse({
    ...manifest(),
    provenance: undefined,
  }).success, false);
  assert.equal(platformReleaseManifestSchema.safeParse({
    ...manifest(),
    canaryEvidence: undefined,
  }).success, false);
  assert.equal(platformReleaseManifestSchema.safeParse({
    ...manifest(),
    affectedConsumers: { cohort: "repository-file-list", resolution: "release-time" },
  }).success, false);
  assert.equal(platformReleaseManifestSchema.safeParse({
    ...manifest(),
    consumers: [{ repoId: "1234", artifactKind: "TYPESCRIPT" }],
  }).success, false);
  assert.equal(platformReleaseManifestSchema.safeParse({
    ...manifest(),
    artifacts: [{ kind: "GDSCRIPT", version: "1.2.3", digest: artifactDigest }],
  }).success, false);
  assert.equal(platformReleaseManifestSchema.safeParse({
    ...manifest(),
    artifacts: [{
      kind: "GDSCRIPT",
      version: "1.2.3",
      digest: artifactDigest,
      treeChecksum: contractRevision,
      releaseAssetUrl: "https://raw.githubusercontent.com/seorilabs/platform/main/platform.gd",
    }],
  }).success, false);
  assert.equal(platformReleaseManifestSchema.safeParse({
    ...manifest(),
    artifacts: [{
      kind: "GDSCRIPT",
      version: "1.2.3",
      digest: artifactDigest,
      treeChecksum: contractRevision,
      releaseAssetUrl: "https://github.com/seorilabs/platform/releases/download/v1.2.3/platform.gd",
    }],
  }).success, true);
});

test("저장된 normalized v0.6.7 omission만 digest identity 변경 없이 read-time 투영한다", () => {
  const storedV067 = structuredClone(manifest()) as unknown as Record<string, unknown>;
  storedV067.version = "0.6.7";
  (storedV067.provenance as Record<string, unknown>).releaseTag = "v0.6.7";
  delete storedV067.affectedConsumers;
  const storedBytes = JSON.stringify(storedV067);

  assert.equal(platformReleaseManifestSchema.safeParse(storedV067).success, false);
  assert.deepEqual(
    parseStoredPlatformReleaseManifest(storedV067).affectedConsumers,
    PLATFORM_AFFECTED_CONSUMERS,
  );
  assert.equal(JSON.stringify(storedV067), storedBytes);
  assert.equal(Object.hasOwn(storedV067, "affectedConsumers"), false);

  for (const version of ["0.6.6", "0.6.8"]) {
    const unsupported = structuredClone(storedV067) as Record<string, unknown>;
    unsupported.version = version;
    (unsupported.provenance as Record<string, unknown>).releaseTag = `v${version}`;
    assert.throws(() => parseStoredPlatformReleaseManifest(unsupported));
  }
  const mismatchedTag = structuredClone(storedV067) as Record<string, unknown>;
  (mismatchedTag.provenance as Record<string, unknown>).releaseTag = "v0.6.8";
  assert.throws(() => parseStoredPlatformReleaseManifest(mismatchedTag));
});

test("구현 drift와 계약 drift를 분리하고 custom/missing remediation을 큐잉한다", () => {
  const artifact = manifest().artifacts[0];
  const observed = {
    schemaVersion: 1 as const,
    sourceSha,
    integration: "SDK" as const,
    artifactKind: "TYPESCRIPT" as const,
    observedVersion: "1.2.2",
    observedDigest: "d".repeat(64),
    contractRevision: "e".repeat(64),
  };
  assert.equal(platformFleetDisposition({
    classification: "IMPLEMENTATION_ONLY",
    contractRevision,
    artifact,
    observation: observed,
  }).kind, "SDK_UPDATE_PR");
  assert.equal(platformFleetDisposition({
    classification: "IMPLEMENTATION_ONLY",
    contractRevision,
    artifact,
    observation: {
      ...observed,
      observedDigest: null,
      contractRevision: null,
    },
  }).kind, "SDK_UPDATE_PR");
  assert.equal(platformFleetDisposition({
    classification: "CONTRACT_CHANGE",
    contractRevision,
    artifact,
    observation: observed,
  }).kind, "CONTRACT_ISSUE");
  const custom = platformFleetDisposition({
    classification: "CONTRACT_ADDITION",
    contractRevision,
    artifact,
    observation: { schemaVersion: 1, sourceSha, integration: "CUSTOM_HTTP", evidenceDigest: artifactDigest },
  });
  assert.equal(custom.kind, "CUSTOM_UNMANAGED");
  assert.equal(custom.status, "PENDING");
  assert.equal(custom.bindingState, "CUSTOM_UNMANAGED_REMEDIATION_PENDING");
  const missing = platformFleetDisposition({
    classification: "IMPLEMENTATION_ONLY",
    contractRevision,
    artifact,
    observation: { schemaVersion: 1, sourceSha, integration: "MISSING", evidenceDigest: artifactDigest },
  });
  assert.equal(missing.kind, "MISSING_UNMANAGED");
  assert.equal(missing.status, "PENDING");
  assert.equal(missing.bindingState, "MISSING_UNMANAGED_REMEDIATION_PENDING");
  assert.equal(platformFleetDisposition({
    classification: "IMPLEMENTATION_ONLY",
    contractRevision,
    artifact,
    observation: {
      ...observed,
      observedVersion: artifact.version,
      observedDigest: artifact.digest,
      contractRevision,
    },
  }).kind, "COMPLIANT");
});

test("contract Issue task는 P1/autopilot/platform labels를 고정하고 secret-like 확장을 거부한다", () => {
  const task = {
    schemaVersion: 1 as const,
    kind: "PLATFORM_CONTRACT_ISSUE" as const,
    planId: "plan-1",
    repoId: "1234",
    repoFullName: "seorilabs/example",
    sourceSha,
    manifestDigest,
    releaseVersion: "1.2.3",
    releaseSourceSha,
    contractRevision,
    classification: "CONTRACT_CHANGE" as const,
    artifact: manifest().artifacts[0],
    issueMarker: `<!-- seorilabs-platform-fleet:${manifestDigest}:1234 -->`,
    title: "[P1] Platform 1.2.3 계약 변경 대응",
    body: `<!-- seorilabs-platform-fleet:${manifestDigest}:1234 -->\n계약 변경 대응`,
    labels: ["P1", "autopilot", "platform", "platform-contract"] as const,
  };
  const parsed = platformFleetTaskInputSchema.parse(task);
  assert.equal(parsed.kind, "PLATFORM_CONTRACT_ISSUE");
  if (parsed.kind !== "PLATFORM_CONTRACT_ISSUE") assert.fail("contract Issue task가 필요합니다.");
  assert.deepEqual(parsed.labels, task.labels);
  assert.equal(platformFleetTaskInputSchema.safeParse({ ...task, apiKey: "forbidden" }).success, false);
});

test("custom/missing remediation Issue는 contract와 다른 stable marker와 label을 사용한다", () => {
  const task = {
    schemaVersion: 1 as const,
    kind: "PLATFORM_INTEGRATION_REMEDIATION_ISSUE" as const,
    planId: "plan-remediation-1",
    repoId: "1234",
    repoFullName: "seorilabs/example",
    sourceSha,
    manifestDigest,
    releaseVersion: "1.2.3",
    releaseSourceSha,
    contractRevision,
    integration: "CUSTOM_HTTP" as const,
    artifact: manifest().artifacts[0],
    issueMarker: "<!-- seorilabs-platform-remediation:v1:1234 -->",
    title: "[P1] Platform custom HTTP 연동을 공식 SDK로 전환",
    body: "<!-- seorilabs-platform-remediation:v1:1234 -->\n공식 SDK 전환",
    labels: ["P1", "autopilot", "platform", "platform-remediation"] as const,
  };
  const parsed = platformFleetTaskInputSchema.parse(task);
  assert.equal(parsed.kind, "PLATFORM_INTEGRATION_REMEDIATION_ISSUE");
  assert.deepEqual(parsed.labels, task.labels);
  assert.notEqual(task.issueMarker, `<!-- seorilabs-platform-fleet:${manifestDigest}:1234 -->`);
  assert.equal(platformFleetTaskInputSchema.safeParse({
    ...task,
    issueMarker: `<!-- seorilabs-platform-fleet:${manifestDigest}:1234 -->`,
  }).success, false);
});

test("durable plan은 release/repo당 하나이며 GitHub mutation은 readback-first adapter 경계만 사용한다", () => {
  const migration = readFileSync(join(
    process.cwd(),
    "prisma/migrations/20260828240000_platform_fleet_reconciler/migration.sql",
  ), "utf8");
  const service = readFileSync(join(process.cwd(), "src/lib/control-plane/platform-fleet.ts"), "utf8");
  const queue = readFileSync(join(process.cwd(), "src/lib/control-plane/agent-queue.ts"), "utf8");
  assert.doesNotMatch(migration, /\b(?:DROP|MODIFY|CHANGE|TRUNCATE|RENAME)\b/i);
  assert.match(migration, /UNIQUE INDEX `platform_fleet_plan_platformReleaseId_appId_key`/);
  assert.match(migration, /UNIQUE INDEX `platform_fleet_plan_workKey_key`/);
  assert.match(service, /findIssueByMarker[\s\S]*createIssue[\s\S]*readIssue/);
  assert.match(service, /ensureLabels[\s\S]*findIssueByMarker/);
  assert.match(service, /catch \(error\)[\s\S]*findIssueByMarker[\s\S]*if \(!issue\) throw error/);
  assert.match(service, /status: "READBACK_REQUIRED"[\s\S]*readbackRequestedAt: new Date\(\)/);
  assert.match(queue, /claimSource: "platform-fleet-plan"|parseManagedWorkerPolicy/);
  assert.doesNotMatch(queue, /fleetProjectProjection|projectNodeId|ProjectV2/);
});

test("release candidate와 운영 scheduler는 stale SDK를 fail-closed한다", () => {
  const ledger = readFileSync(join(process.cwd(), "src/lib/control-plane/release-ledger.ts"), "utf8");
  const scheduler = readFileSync(join(process.cwd(), "k8s/scheduler-cronjobs.yaml"), "utf8");
  const schedulerRoute = readFileSync(join(
    process.cwd(),
    "src/app/api/admin/automation/platform-fleet/route.ts",
  ), "utf8");
  assert.match(ledger, /latestApplicablePlatformRelease[\s\S]*platformBinding\.state !== "COMPLIANT"/);
  assert.match(ledger, /canaryEvidence\.workflowBundle\.sourceSha[\s\S]*workflowBundleDigest/);
  assert.match(ledger, /payload\.build\?\.workflowBundleDigest[\s\S]*WORKFLOW_BUNDLE_DIGEST_MISMATCH/);
  assert.match(ledger, /WORKFLOW_BUNDLE_APPROVAL_MISMATCH/);
  assert.match(ledger, /PLATFORM_FLEET_STALE/);
  assert.match(scheduler, /name: backoffice-platform-fleet/);
  assert.match(scheduler, /concurrencyPolicy: Forbid[\s\S]*\/api\/admin\/automation\/platform-fleet/);
  assert.ok(schedulerRoute.indexOf("drainPlatformFleetPlans()") < schedulerRoute.indexOf("producePlatformFleetRelease()"));
  assert.match(schedulerRoute, /let drainError: unknown;[\s\S]*let producerError: unknown;/);
});

test("Platform API는 secret export 표면이나 signature 값을 응답하지 않는다", () => {
  const route = readFileSync(join(
    process.cwd(),
    "src/app/api/control-plane/platform-releases/route.ts",
  ), "utf8");
  const allRoutes = readFileSync(join(
    process.cwd(),
    "src/app/api/control-plane/platform-fleet/reconcile/route.ts",
  ), "utf8");
  const providerRoute = readFileSync(join(
    process.cwd(),
    "src/app/api/control-plane/provider-observations/route.ts",
  ), "utf8");
  assert.doesNotMatch(route, /signature: result\.release\.signature/);
  assert.doesNotMatch(route, /export async function POST|recordPlatformRelease/);
  assert.doesNotMatch(`${route}\n${allRoutes}`, /get-secret|print-secret|copy-password/i);
  assert.match(providerRoute, /platformConsumerObservationPayloadSchema\.parse/);
  assert.match(providerRoute, /body\.resourceId !== body\.repoId\.toString\(\)/);
});
