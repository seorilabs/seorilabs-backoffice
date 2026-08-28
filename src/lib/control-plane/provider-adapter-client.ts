import {
  createPrivateKey,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";

import {
  providerCommandEnvelopeSchema,
  type ProviderCommandEnvelope,
} from "@/lib/control-plane/contracts";

const ATTESTATION_DOMAIN = "seori-run-attestation-v1\n";
const RESPONSE_LIMIT = 64 * 1024;
const PUBLIC_ERROR = /^[a-z][a-z0-9_]{0,127}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;

export interface ProviderAdapterResult {
  outcome: "COMMAND_ACCEPTED" | "RESULT_UNKNOWN" | "FAILED" | "HUMAN_REQUIRED";
  errorCode?: string;
}

export interface ProviderAdapterExecutor {
  execute(envelope: ProviderCommandEnvelope): Promise<ProviderAdapterResult>;
}

export function buildAuthBrokerLeaseRequest(envelope: ProviderCommandEnvelope, subject: string) {
  const command = providerCommandEnvelopeSchema.parse(envelope);
  return {
    credentialRef: command.credential.logicalId,
    credentialGeneration: command.credential.generation,
    policyGeneration: command.credential.policyGeneration,
    subject,
    runId: command.executionId,
    repository: command.repository,
    commitSha: command.sourceSha,
    provider: command.provider,
    origin: command.origin,
    redirectOrigins: [],
    capability: command.credential.capability,
    resource: {
      kind: `${command.provider}.${command.resource.type}`,
      // auth lease 자체도 전체 exact binding digest에 고정한다. arbitrary resource path를 넘기지 않는다.
      id: `binding:${command.bindingHash}`,
      environment: command.resource.environment,
    },
    ...(command.artifactChecksum ? { artifact: { sha256: command.artifactChecksum } } : {}),
    adapterId: command.adapterId,
    accountId: command.credential.publicAccountId,
    authFactors: command.credential.authFactors,
    approval: command.approval,
  };
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function signRunAttestation(input: {
  privateKey: string | Buffer | KeyObject;
  clientSpiffeId: string;
  subject: string;
  runId: string;
  repository: string;
  workerId: string;
  now: number;
  nonce?: string;
}) {
  const payload = base64UrlJson({
    version: 1,
    clientSpiffeId: input.clientSpiffeId,
    issuedAt: input.now,
    expiresAt: input.now + 60_000,
    nonce: input.nonce ?? randomBytes(18).toString("base64url"),
    subject: input.subject,
    runId: input.runId,
    repository: input.repository,
    workerId: input.workerId,
  });
  const privateKey = typeof input.privateKey === "string" || Buffer.isBuffer(input.privateKey)
    ? createPrivateKey(input.privateKey)
    : input.privateKey;
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("RUN_ATTESTATION_KEY_INVALID");
  const signature = sign(null, Buffer.from(`${ATTESTATION_DOMAIN}${payload}`, "utf8"), privateKey).toString("base64url");
  return `${payload}.${signature}`;
}

type BrokerTransport = (input: {
  path: string;
  body: Record<string, unknown>;
  attestation: string;
}) => Promise<{ status: number; body: unknown }>;

function safeBrokerError(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "auth_broker_failed";
  const candidate = body as { error?: unknown; code?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : typeof candidate.error === "string" ? candidate.error : "";
  return PUBLIC_ERROR.test(code) ? code : "auth_broker_failed";
}

const HUMAN_ERRORS = new Set([
  "human_reauth_required",
  "reauth_required",
  "browser_reauthentication_required",
  "policy_requires_human_approval",
]);

export class SeoriAuthBrokerProviderAdapter implements ProviderAdapterExecutor {
  readonly #workerId: string;
  readonly #subject: string;
  readonly #clientSpiffeId: string;
  readonly #attestationPrivateKey: KeyObject;
  readonly #transport: BrokerTransport;

  constructor(input: {
    workerId: string;
    subject: string;
    clientSpiffeId: string;
    attestationPrivateKey: string | Buffer;
    transport: BrokerTransport;
  }) {
    this.#workerId = input.workerId;
    this.#subject = input.subject;
    this.#clientSpiffeId = input.clientSpiffeId;
    const attestationPrivateKey = createPrivateKey(input.attestationPrivateKey);
    if (attestationPrivateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("RUN_ATTESTATION_KEY_INVALID");
    }
    this.#attestationPrivateKey = attestationPrivateKey;
    if (Buffer.isBuffer(input.attestationPrivateKey)) input.attestationPrivateKey.fill(0);
    this.#transport = input.transport;
  }

  #attestation(envelope: ProviderCommandEnvelope) {
    return signRunAttestation({
      privateKey: this.#attestationPrivateKey,
      clientSpiffeId: this.#clientSpiffeId,
      subject: this.#subject,
      runId: envelope.executionId,
      repository: envelope.repository,
      workerId: this.#workerId,
      now: Date.now(),
    });
  }

  async execute(envelope: ProviderCommandEnvelope): Promise<ProviderAdapterResult> {
    const command = providerCommandEnvelopeSchema.parse(envelope);
    const request = buildAuthBrokerLeaseRequest(command, this.#subject);
    let issued;
    try {
      issued = await this.#transport({
        path: "/auth/leases",
        body: {
          idempotencyKey: `provider-execution:${command.executionId}:${command.generation}`,
          workerId: this.#workerId,
          request,
        },
        attestation: this.#attestation(command),
      });
    } catch {
      return { outcome: "FAILED", errorCode: "AUTH_BROKER_UNAVAILABLE" };
    }
    if (issued.status !== 201 && issued.status !== 200) {
      const errorCode = safeBrokerError(issued.body);
      return { outcome: HUMAN_ERRORS.has(errorCode) ? "HUMAN_REQUIRED" : "FAILED", errorCode: errorCode.toUpperCase() };
    }
    const checkout = (issued.body as { credentialCheckout?: { id?: unknown; generation?: unknown } })?.credentialCheckout;
    if (!checkout || typeof checkout.id !== "string" || !OPAQUE_ID.test(checkout.id) || !Number.isSafeInteger(checkout.generation) || Number(checkout.generation) < 1) {
      return { outcome: "FAILED", errorCode: "AUTH_BROKER_RESPONSE_INVALID" };
    }
    let executed;
    try {
      executed = await this.#transport({
        path: `/auth/leases/${encodeURIComponent(checkout.id)}/execute`,
        body: {
          expectedGeneration: checkout.generation,
          workerId: this.#workerId,
          context: request,
        },
        attestation: this.#attestation(command),
      });
    } catch {
      // lease execute 요청 전송 뒤의 transport 오류는 외부 결과를 추측할 수 없다.
      return { outcome: "RESULT_UNKNOWN", errorCode: "AUTH_BROKER_EXECUTION_UNKNOWN" };
    }
    if (executed.status !== 200) {
      const errorCode = safeBrokerError(executed.body);
      return { outcome: HUMAN_ERRORS.has(errorCode) ? "HUMAN_REQUIRED" : "RESULT_UNKNOWN", errorCode: errorCode.toUpperCase() };
    }
    const execution = (executed.body as { execution?: { outcome?: unknown } })?.execution;
    if (execution?.outcome === "SUCCESS") return { outcome: "COMMAND_ACCEPTED" };
    if (execution?.outcome === "ADAPTER_FAILED") return { outcome: "FAILED", errorCode: "TRUSTED_ADAPTER_FAILED" };
    return { outcome: "RESULT_UNKNOWN", errorCode: "AUTH_BROKER_RESPONSE_INVALID" };
  }
}

export async function createProductionProviderAdapter(input: {
  workerId: string;
  subject: string;
  clientSpiffeId: string;
  brokerOrigin: string;
}) {
  const origin = new URL(input.brokerOrigin);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("AUTH_BROKER_ORIGIN_INVALID");
  }
  const fixedRoot = "/var/run/seori-provider-execution";
  const [ca, certificate, privateKey, attestationPrivateKey] = await Promise.all([
    readFile(`${fixedRoot}/mtls/ca.pem`),
    readFile(`${fixedRoot}/mtls/tls.crt`),
    readFile(`${fixedRoot}/mtls/tls.key`),
    readFile(`${fixedRoot}/attestation/private.pem`),
  ]);
  const transport: BrokerTransport = ({ path, body, attestation }) => new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(body), "utf8");
    const request = httpsRequest({
      protocol: "https:",
      hostname: origin.hostname,
      port: origin.port ? Number(origin.port) : 443,
      method: "POST",
      path,
      ca,
      cert: certificate,
      key: privateKey,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      servername: origin.hostname,
      headers: {
        "content-type": "application/json",
        "content-length": String(encoded.length),
        "seori-run-attestation": attestation,
      },
      timeout: 10_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > RESPONSE_LIMIT) request.destroy(new Error("AUTH_BROKER_RESPONSE_LIMIT"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        const payload = Buffer.concat(chunks);
        try {
          resolve({ status: response.statusCode ?? 500, body: JSON.parse(payload.toString("utf8")) });
        } catch {
          resolve({ status: response.statusCode ?? 500, body: null });
        } finally {
          payload.fill(0);
          for (const chunk of chunks) chunk.fill(0);
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error("AUTH_BROKER_TIMEOUT")));
    request.once("error", reject);
    let cleared = false;
    const clearEncoded = () => {
      if (cleared) return;
      cleared = true;
      encoded.fill(0);
    };
    request.once("close", clearEncoded);
    request.end(encoded, clearEncoded);
  });
  return new SeoriAuthBrokerProviderAdapter({
    workerId: input.workerId,
    subject: input.subject,
    clientSpiffeId: input.clientSpiffeId,
    attestationPrivateKey,
    transport,
  });
}
