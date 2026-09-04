import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { isIPv4 } from "node:net";

import type { FleetMigrationPublicAttestation } from "@/lib/control-plane/fleet-migration-public-attestation";
import { readBoundSecretFile } from "@/lib/control-plane/seori-auth-agent-transport";

const DNS_NAME = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const MAX_RESPONSE_BYTES = 1024 * 1024;

type KubernetesResource = {
  apiVersion?: unknown;
  kind?: unknown;
  immutable?: unknown;
  metadata?: {
    name?: unknown;
    namespace?: unknown;
    resourceVersion?: unknown;
    uid?: unknown;
    labels?: unknown;
  };
  data?: unknown;
  type?: unknown;
};

function fail(code: string): never {
  throw new Error(code);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactLabels(value: unknown, executionId: string, sourceSha: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const labels = value as Record<string, unknown>;
  return labels["app.kubernetes.io/component"] === "fleet-migration-runtime-capability"
    && labels["seorilabs.dev/execution-id"] === executionId
    && labels["seorilabs.dev/source-sha"] === sourceSha;
}

function assertEmptyResource(input: {
  value: unknown;
  kind: "ConfigMap" | "Secret";
  name: string;
  namespace: string;
  executionId: string;
  sourceSha: string;
}): KubernetesResource & { metadata: { resourceVersion: string; uid: string } } {
  const value = input.value as KubernetesResource | null;
  const data = value?.data;
  if (
    !value
    || value.apiVersion !== "v1"
    || value.kind !== input.kind
    || value.metadata?.name !== input.name
    || value.metadata.namespace !== input.namespace
    || typeof value.metadata.resourceVersion !== "string"
    || !/^[1-9][0-9]{0,31}$/u.test(value.metadata.resourceVersion)
    || typeof value.metadata.uid !== "string"
    || !/^[A-Za-z0-9-]{16,128}$/u.test(value.metadata.uid)
    || !exactLabels(value.metadata.labels, input.executionId, input.sourceSha)
    || value.immutable === true
    || (data !== undefined && (
      !data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== 0
    ))
    || (input.kind === "Secret" && value.type !== "Opaque")
  ) fail("FLEET_MIGRATION_KUBERNETES_SINK_PRECONDITION_FAILED");
  return value as KubernetesResource & { metadata: { resourceVersion: string; uid: string } };
}

function assertWrittenResource(input: {
  value: unknown;
  kind: "ConfigMap" | "Secret";
  name: string;
  namespace: string;
  executionId: string;
  sourceSha: string;
  expectedKeys: string[];
}): Record<string, string> {
  const value = input.value as KubernetesResource | null;
  const data = value?.data;
  if (
    !value
    || value.apiVersion !== "v1"
    || value.kind !== input.kind
    || value.metadata?.name !== input.name
    || value.metadata.namespace !== input.namespace
    || value.immutable !== true
    || !exactLabels(value.metadata.labels, input.executionId, input.sourceSha)
    || !data
    || typeof data !== "object"
    || Array.isArray(data)
    || JSON.stringify(Object.keys(data).sort()) !== JSON.stringify([...input.expectedKeys].sort())
    || Object.values(data).some((item) => typeof item !== "string")
  ) fail("FLEET_MIGRATION_KUBERNETES_SINK_READBACK_FAILED");
  return data as Record<string, string>;
}

async function readResponse(response: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_RESPONSE_BYTES) fail("FLEET_MIGRATION_KUBERNETES_RESPONSE_TOO_LARGE");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

export interface FleetMigrationKubernetesCapabilitySinkInput {
  namespace: string;
  secretName: string;
  configMapName: string;
  executionId: string;
  sourceSha: string;
  authRoot: string;
  tokenFile: string;
  caFile: string;
  host: string;
  port: number;
  requestJson?: KubernetesRequest;
}

export type KubernetesRequest = (
  method: "DELETE" | "GET" | "PUT",
  path: string,
  body?: Buffer,
) => Promise<unknown>;

function authenticatedRequest(input: {
  host: string;
  port: number;
  serviceAccountToken: Buffer;
  ca: Buffer;
}): KubernetesRequest {
  return async (method, path, body) => {
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const request = httpsRequest({
        hostname: input.host,
        port: input.port,
        path,
        method,
        ca: input.ca,
        servername: "kubernetes.default.svc",
        rejectUnauthorized: true,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.serviceAccountToken.toString("utf8").trim()}`,
          ...(body ? {
            "Content-Length": String(body.length),
            "Content-Type": "application/json",
          } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      }, async (response) => {
        try {
          const responseBytes = await readResponse(response);
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            responseBytes.fill(0);
            reject(new Error(`FLEET_MIGRATION_KUBERNETES_REQUEST_FAILED:${status}`));
            return;
          }
          resolve(responseBytes);
        } catch (error) {
          reject(error);
        }
      });
      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    });
    if (method === "DELETE") {
      bytes.fill(0);
      return null;
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("FLEET_MIGRATION_KUBERNETES_RESPONSE_INVALID");
    } finally {
      bytes.fill(0);
    }
  };
}

export function createFleetMigrationKubernetesCapabilitySink(
  input: FleetMigrationKubernetesCapabilitySinkInput,
) {
  if (
    !DNS_NAME.test(input.namespace)
    || !DNS_NAME.test(input.secretName)
    || !DNS_NAME.test(input.configMapName)
    || !EXECUTION_ID.test(input.executionId)
    || !SOURCE_SHA.test(input.sourceSha)
    || !isIPv4(input.host)
    || !Number.isSafeInteger(input.port)
    || input.port < 1
    || input.port > 65_535
  ) fail("FLEET_MIGRATION_KUBERNETES_SINK_CONFIGURATION_INVALID");
  const basePath = `/api/v1/namespaces/${input.namespace}`;

  return async (delivery: {
    token: string;
    attestation: FleetMigrationPublicAttestation;
    publicKeyPem: string;
  }): Promise<void> => {
    let serviceAccountToken: Buffer | undefined;
    let ca: Buffer | undefined;
    let tokenBody: Buffer | undefined;
    let publicBody: Buffer | undefined;
    let secretWriteAttempted = false;
    let configMapWriteAttempted = false;
    let secretUid = "";
    let configMapUid = "";
    let request: KubernetesRequest | undefined = input.requestJson;
    try {
      if (!request) {
        serviceAccountToken = await readBoundSecretFile({
          root: input.authRoot,
          relativePath: input.tokenFile,
          allowGroupRead: true,
          maxBytes: 32 * 1024,
        });
        ca = await readBoundSecretFile({
          root: input.authRoot,
          relativePath: input.caFile,
          allowGroupRead: true,
          maxBytes: 1024 * 1024,
        });
        request = authenticatedRequest({
          host: input.host,
          port: input.port,
          serviceAccountToken,
          ca,
        });
      }
      const secretPath = `${basePath}/secrets/${input.secretName}`;
      const configMapPath = `${basePath}/configmaps/${input.configMapName}`;
      const secret = assertEmptyResource({
        value: await request("GET", secretPath),
        kind: "Secret",
        name: input.secretName,
        namespace: input.namespace,
        executionId: input.executionId,
        sourceSha: input.sourceSha,
      });
      const configMap = assertEmptyResource({
        value: await request("GET", configMapPath),
        kind: "ConfigMap",
        name: input.configMapName,
        namespace: input.namespace,
        executionId: input.executionId,
        sourceSha: input.sourceSha,
      });
      secretUid = secret.metadata.uid;
      configMapUid = configMap.metadata.uid;
      tokenBody = Buffer.from(JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: input.secretName,
          namespace: input.namespace,
          resourceVersion: secret.metadata.resourceVersion,
          labels: secret.metadata.labels,
        },
        immutable: true,
        type: "Opaque",
        data: { "installation.token": Buffer.from(delivery.token, "utf8").toString("base64") },
      }), "utf8");
      secretWriteAttempted = true;
      await request("PUT", secretPath, tokenBody);
      publicBody = Buffer.from(JSON.stringify({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: input.configMapName,
          namespace: input.namespace,
          resourceVersion: configMap.metadata.resourceVersion,
          labels: configMap.metadata.labels,
        },
        immutable: true,
        data: {
          "runtime-attestation.json": JSON.stringify(delivery.attestation),
          "runtime-attestation-public.pem": delivery.publicKeyPem,
        },
      }), "utf8");
      configMapWriteAttempted = true;
      await request("PUT", configMapPath, publicBody);
      const writtenSecret = assertWrittenResource({
        value: await request("GET", secretPath),
        kind: "Secret",
        name: input.secretName,
        namespace: input.namespace,
        executionId: input.executionId,
        sourceSha: input.sourceSha,
        expectedKeys: ["installation.token"],
      });
      const writtenConfigMap = assertWrittenResource({
        value: await request("GET", configMapPath),
        kind: "ConfigMap",
        name: input.configMapName,
        namespace: input.namespace,
        executionId: input.executionId,
        sourceSha: input.sourceSha,
        expectedKeys: ["runtime-attestation.json", "runtime-attestation-public.pem"],
      });
      const encodedToken = writtenSecret["installation.token"]!;
      let readbackToken: Buffer | undefined;
      try {
        readbackToken = Buffer.from(encodedToken, "base64");
        if (
          readbackToken.toString("base64") !== encodedToken
          || sha256(readbackToken) !== sha256(delivery.token)
          || writtenConfigMap["runtime-attestation.json"] !== JSON.stringify(delivery.attestation)
          || writtenConfigMap["runtime-attestation-public.pem"] !== delivery.publicKeyPem
        ) fail("FLEET_MIGRATION_KUBERNETES_SINK_READBACK_FAILED");
      } finally {
        readbackToken?.fill(0);
      }
    } catch (error) {
      const deletions: Array<Promise<unknown>> = [];
      if (configMapWriteAttempted) {
        deletions.push(request!(
          "DELETE",
          `${basePath}/configmaps/${input.configMapName}`,
          Buffer.from(JSON.stringify({
            apiVersion: "v1",
            kind: "DeleteOptions",
            preconditions: { uid: configMapUid },
          }), "utf8"),
        ));
      }
      if (secretWriteAttempted) {
        deletions.push(request!(
          "DELETE",
          `${basePath}/secrets/${input.secretName}`,
          Buffer.from(JSON.stringify({
            apiVersion: "v1",
            kind: "DeleteOptions",
            preconditions: { uid: secretUid },
          }), "utf8"),
        ));
      }
      const rollback = await Promise.allSettled(deletions);
      const rollbackErrors = rollback.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (rollbackErrors.length > 0) {
        throw new Error("FLEET_MIGRATION_KUBERNETES_SINK_ROLLBACK_FAILED", {
          cause: new AggregateError([error, ...rollbackErrors]),
        });
      }
      throw error;
    } finally {
      serviceAccountToken?.fill(0);
      ca?.fill(0);
      tokenBody?.fill(0);
      publicBody?.fill(0);
    }
  };
}
