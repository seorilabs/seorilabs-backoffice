import assert from "node:assert/strict";
import test from "node:test";

import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  loadExactManagedPlatformConsumers,
  resolvePlatformFleetConsumerCoverage,
} from "@/lib/control-plane/platform-fleet-cohort";
import { ControlPlaneError } from "@/lib/control-plane/service";

const CURRENT_SHA = "1".repeat(40);

function registration(input: {
  repoId: bigint;
  repoFullName?: string;
  status?: string;
  classification?: string | null;
  archived?: boolean;
  sourceSha?: string | null;
  lastDiscoveryReason?: string | null;
}) {
  return {
    repoId: input.repoId,
    repoFullName: input.repoFullName ?? `seorilabs/app-${input.repoId}`,
    archived: input.archived ?? false,
    status: input.status ?? "MANAGED",
    managementKind: "APP",
    classification: input.classification === undefined ? "PRODUCT_APP" : input.classification,
    lastDefaultPushSha: input.sourceSha === undefined ? CURRENT_SHA : input.sourceSha,
    lastReconciledSha: input.sourceSha === undefined ? CURRENT_SHA : input.sourceSha,
    lastDiscoveryReason: input.lastDiscoveryReason ?? null,
  };
}

function discovery(appId: string, input: {
  sourceSha?: string;
  payloadHash?: string;
  observedAppId?: string;
} = {}) {
  const payload = { stack: "react-native", marker: appId } as JsonValue;
  return {
    id: `discovery-${appId}`,
    appId: input.observedAppId ?? appId,
    sourceSha: input.sourceSha ?? CURRENT_SHA,
    payload,
    payloadHash: input.payloadHash ?? jsonDigest(payload),
    observedAt: new Date("2026-08-31T00:00:00.000Z"),
  };
}

function app(input: {
  repoId: bigint;
  status?: "ACTIVE" | "PAUSED" | "DEPRECATED";
  discovery?: ReturnType<typeof discovery> | null;
}) {
  const id = `app-${input.repoId}`;
  return {
    id,
    repoId: input.repoId,
    repoFullName: `seorilabs/app-${input.repoId}`,
    status: input.status ?? "ACTIVE",
    engine: "RN" as const,
    discoveryObservations: input.discovery === null
      ? []
      : [input.discovery ?? discovery(id)],
  };
}

test("Platform cohort 분모는 ACTIVE PRODUCT_APP만 포함한다", () => {
  const apps = [
    app({ repoId: 1n }),
    app({ repoId: 2n }),
    app({ repoId: 3n, status: "PAUSED" }),
    app({ repoId: 4n, status: "DEPRECATED" }),
    app({ repoId: 5n }),
  ];
  const coverage = resolvePlatformFleetConsumerCoverage({
    apps,
    registrations: [
      registration({ repoId: 1n }),
      registration({ repoId: 2n, classification: "PLATFORM_PRODUCER" }),
      registration({ repoId: 3n }),
      registration({ repoId: 4n }),
      registration({ repoId: 5n, archived: true }),
    ],
  });

  assert.equal(coverage.denominator, 1);
  assert.equal(coverage.ready, 1);
  assert.equal(coverage.blocked, 0);
  assert.deepEqual(coverage.consumers.map(({ app: consumer }) => consumer.repoId), [1n]);
});

test("NEEDS_INPUT과 discovery 누락을 구분하고 부분 fanout을 차단한다", async () => {
  const apps = [
    app({ repoId: 10n, discovery: null }),
    app({ repoId: 11n, discovery: null }),
  ];
  const registrations = [
    registration({
      repoId: 10n,
      status: "NEEDS_INPUT",
      sourceSha: null,
      lastDiscoveryReason: "NO_CANDIDATE",
    }),
    registration({ repoId: 11n }),
  ];
  const coverage = resolvePlatformFleetConsumerCoverage({ apps, registrations });

  assert.equal(coverage.denominator, 2);
  assert.equal(coverage.ready, 0);
  assert.equal(coverage.blocked, 2);
  assert.equal(coverage.reasonCounts.REGISTRATION_NEEDS_INPUT, 1);
  assert.equal(coverage.reasonCounts.DISCOVERY_MISSING, 1);
  assert.deepEqual(
    coverage.blockers.map(({ reason }) => reason),
    ["REGISTRATION_NEEDS_INPUT", "DISCOVERY_MISSING"],
  );

  const client = {
    app: { findMany: async () => apps },
    repositoryRegistration: { findMany: async () => registrations },
  } as unknown as NonNullable<Parameters<typeof loadExactManagedPlatformConsumers>[0]>;
  await assert.rejects(
    loadExactManagedPlatformConsumers(client),
    (error) => error instanceof ControlPlaneError
      && error.code === "PLATFORM_DISCOVERY_COHORT_INCOMPLETE"
      && error.message.includes("denominator=2,ready=0,blocked=2")
      && error.message.includes("REGISTRATION_NEEDS_INPUT=1")
      && error.message.includes("DISCOVERY_MISSING=1"),
  );
});
