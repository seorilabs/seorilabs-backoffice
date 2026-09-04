import assert from "node:assert/strict";
import test from "node:test";

import { createFleetMigrationKubernetesCapabilitySink, type KubernetesRequest } from "@/lib/control-plane/fleet-migration-kubernetes-capability-sink";
import type { FleetMigrationPublicAttestation } from "@/lib/control-plane/fleet-migration-public-attestation";

const SOURCE_SHA = "a".repeat(40);
const EXECUTION_ID = "fleet-runtime-execution-0001";
const SECRET_NAME = "fleet-runtime-token-0001";
const CONFIG_MAP_NAME = "fleet-runtime-public-0001";
const TOKEN = "github-read-capability-value-0000000001";
const LABELS = {
  "app.kubernetes.io/name": "backoffice",
  "app.kubernetes.io/component": "fleet-migration-runtime-capability",
  "seorilabs.dev/execution-id": EXECUTION_ID,
  "seorilabs.dev/source-sha": SOURCE_SHA,
};
const ATTESTATION = {
  contract: "seorilabs-fleet-migration-public-attestation-v1",
  purpose: "SHADOW_RUNTIME",
  keyId: "fleet-migration-runtime-v1",
  keyFingerprint: "b".repeat(64),
  policyRevision: "fleet-migration-runtime-policy-v1",
  issuedAt: "2026-09-04T00:00:00.000Z",
  expiresAt: "2026-09-04T01:00:00.000Z",
  nonce: "fleet-runtime-nonce-0001",
  payloadDigest: "c".repeat(64),
  payload: { state: "READY" },
  signature: "d".repeat(86),
} as FleetMigrationPublicAttestation;

type Call = { method: "DELETE" | "GET" | "PUT"; path: string; body?: Record<string, unknown> };

function emptyResource(kind: "ConfigMap" | "Secret", name: string) {
  return {
    apiVersion: "v1",
    kind,
    metadata: { name, namespace: "platform", resourceVersion: "1", uid: `00000000-0000-4000-8000-${kind === "Secret" ? "000000000001" : "000000000002"}`, labels: LABELS },
    ...(kind === "Secret" ? { type: "Opaque" } : {}),
    data: {},
  };
}

function sink(requestJson: KubernetesRequest) {
  return createFleetMigrationKubernetesCapabilitySink({
    namespace: "platform",
    secretName: SECRET_NAME,
    configMapName: CONFIG_MAP_NAME,
    executionId: EXECUTION_ID,
    sourceSha: SOURCE_SHA,
    authRoot: "/run/fleet-runtime-issuer/kubernetes",
    tokenFile: "token",
    caFile: "ca.crt",
    host: "10.152.183.1",
    port: 443,
    requestJson,
  });
}

test("runtime capability sink atomically fills exact empty objects and returns no secret", async () => {
  const calls: Call[] = [];
  const resources = new Map<string, Record<string, unknown>>([
    [`/api/v1/namespaces/platform/secrets/${SECRET_NAME}`, emptyResource("Secret", SECRET_NAME)],
    [`/api/v1/namespaces/platform/configmaps/${CONFIG_MAP_NAME}`, emptyResource("ConfigMap", CONFIG_MAP_NAME)],
  ]);
  const request: KubernetesRequest = async (method, path, body) => {
    calls.push({ method, path, body: body ? JSON.parse(body.toString("utf8")) : undefined });
    if (method === "GET") return structuredClone(resources.get(path));
    if (method === "PUT") {
      const value = JSON.parse(body!.toString("utf8")) as Record<string, unknown>;
      resources.set(path, { ...value, metadata: { ...(value.metadata as object), resourceVersion: "2" } });
      return structuredClone(resources.get(path));
    }
    resources.delete(path);
    return null;
  };

  const result = await sink(request)({ token: TOKEN, attestation: ATTESTATION, publicKeyPem: "public-key" });
  assert.equal(result, undefined);
  assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET", "PUT", "PUT", "GET", "GET"]);
  const storedSecret = resources.get(`/api/v1/namespaces/platform/secrets/${SECRET_NAME}`)!;
  assert.equal(storedSecret.immutable, true);
  assert.deepEqual(Object.keys(storedSecret.data as object), ["installation.token"]);
  assert.equal(Buffer.from((storedSecret.data as Record<string, string>)["installation.token"]!, "base64").toString(), TOKEN);
  assert.equal(JSON.stringify(result), undefined);
});

test("runtime capability sink deletes every written object when readback fails", async () => {
  const calls: Call[] = [];
  const resources = new Map<string, Record<string, unknown>>([
    [`/api/v1/namespaces/platform/secrets/${SECRET_NAME}`, emptyResource("Secret", SECRET_NAME)],
    [`/api/v1/namespaces/platform/configmaps/${CONFIG_MAP_NAME}`, emptyResource("ConfigMap", CONFIG_MAP_NAME)],
  ]);
  let putCount = 0;
  const request: KubernetesRequest = async (method, path, body) => {
    calls.push({ method, path, body: body ? JSON.parse(body.toString("utf8")) : undefined });
    if (method === "GET") {
      if (putCount === 2 && path.includes("configmaps")) return { ...resources.get(path), data: {} };
      return structuredClone(resources.get(path));
    }
    if (method === "PUT") {
      putCount += 1;
      resources.set(path, JSON.parse(body!.toString("utf8")) as Record<string, unknown>);
      return structuredClone(resources.get(path));
    }
    resources.delete(path);
    return null;
  };

  await assert.rejects(
    sink(request)({ token: TOKEN, attestation: ATTESTATION, publicKeyPem: "public-key" }),
    /FLEET_MIGRATION_KUBERNETES_SINK_READBACK_FAILED/,
  );
  assert.deepEqual(calls.slice(-2).map(({ method, path }) => [method, path]), [
    ["DELETE", `/api/v1/namespaces/platform/configmaps/${CONFIG_MAP_NAME}`],
    ["DELETE", `/api/v1/namespaces/platform/secrets/${SECRET_NAME}`],
  ]);
  for (const { body } of calls.slice(-2)) {
    assert.equal(body?.kind, "DeleteOptions");
    assert.match(String(record(body?.preconditions).uid), /^[0-9a-f-]{36}$/u);
  }
  assert.equal(resources.size, 0);
});

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && !Array.isArray(value) && typeof value === "object");
  return value as Record<string, unknown>;
}

test("runtime capability sink rejects a non-empty precondition before any write", async () => {
  const calls: Call[] = [];
  const request: KubernetesRequest = async (method, path) => {
    calls.push({ method, path });
    if (path.includes("secrets")) {
      return { ...emptyResource("Secret", SECRET_NAME), data: { existing: "value" } };
    }
    return emptyResource("ConfigMap", CONFIG_MAP_NAME);
  };
  await assert.rejects(
    sink(request)({ token: TOKEN, attestation: ATTESTATION, publicKeyPem: "public-key" }),
    /FLEET_MIGRATION_KUBERNETES_SINK_PRECONDITION_FAILED/,
  );
  assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
});
