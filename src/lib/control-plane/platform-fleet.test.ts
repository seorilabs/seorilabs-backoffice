import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
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
    publishedAt: "2026-08-28T00:00:00.000Z",
    artifacts: [{
      kind: "TYPESCRIPT",
      version: "1.2.3",
      digest: artifactDigest,
      packageName: "@seorilabs/platform",
    }],
    consumers: [{ repoId: "1234", artifactKind: "TYPESCRIPT" }],
  };
}

test("Platform release 계약은 승인, exact artifact, consumer 중복을 fail-closed한다", () => {
  assert.deepEqual(platformReleaseManifestSchema.parse(manifest()), manifest());
  assert.equal(platformReleaseManifestSchema.safeParse({
    ...manifest(),
    approval: "DRAFT",
  }).success, false);
  assert.equal(platformReleaseManifestSchema.safeParse({
    ...manifest(),
    consumers: [
      { repoId: "1234", artifactKind: "TYPESCRIPT" },
      { repoId: "1234", artifactKind: "TYPESCRIPT" },
    ],
  }).success, false);
  assert.equal(platformReleaseManifestSchema.safeParse({
    ...manifest(),
    artifacts: [{ kind: "GDSCRIPT", version: "1.2.3", digest: artifactDigest }],
    consumers: [{ repoId: "1234", artifactKind: "GDSCRIPT" }],
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
    consumers: [{ repoId: "1234", artifactKind: "GDSCRIPT" }],
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
    consumers: [{ repoId: "1234", artifactKind: "GDSCRIPT" }],
  }).success, true);
});

test("구현 drift와 계약 drift를 분리하고 custom/missing을 unmanaged로 관측한다", () => {
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
  assert.equal(platformFleetDisposition({
    classification: "CONTRACT_ADDITION",
    contractRevision,
    artifact,
    observation: { schemaVersion: 1, sourceSha, integration: "CUSTOM_HTTP", evidenceDigest: artifactDigest },
  }).kind, "CUSTOM_UNMANAGED");
  assert.equal(platformFleetDisposition({
    classification: "IMPLEMENTATION_ONLY",
    contractRevision,
    artifact,
    observation: { schemaVersion: 1, sourceSha, integration: "MISSING", evidenceDigest: artifactDigest },
  }).kind, "MISSING_UNMANAGED");
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
  assert.match(service, /catch \(error\)[\s\S]*findIssueByMarker[\s\S]*if \(!issue\) throw error/);
  assert.match(service, /status: "READBACK_REQUIRED"[\s\S]*readbackRequestedAt: new Date\(\)/);
  assert.match(queue, /claimSource: "platform-fleet-plan"|parseManagedWorkerPolicy/);
  assert.doesNotMatch(queue, /fleetProjectProjection|projectNodeId|ProjectV2/);
});

test("release candidate와 운영 scheduler는 stale SDK를 fail-closed한다", () => {
  const ledger = readFileSync(join(process.cwd(), "src/lib/control-plane/release-ledger.ts"), "utf8");
  const scheduler = readFileSync(join(process.cwd(), "k8s/scheduler-cronjobs.yaml"), "utf8");
  assert.match(ledger, /latestApplicablePlatformRelease[\s\S]*platformBinding\.state !== "COMPLIANT"/);
  assert.match(ledger, /PLATFORM_FLEET_STALE/);
  assert.match(scheduler, /name: backoffice-platform-fleet/);
  assert.match(scheduler, /concurrencyPolicy: Forbid[\s\S]*\/api\/admin\/automation\/platform-fleet/);
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
  assert.doesNotMatch(`${route}\n${allRoutes}`, /get-secret|print-secret|copy-password/i);
  assert.match(providerRoute, /platformConsumerObservationPayloadSchema\.parse/);
  assert.match(providerRoute, /body\.resourceId !== body\.repoId\.toString\(\)/);
});
