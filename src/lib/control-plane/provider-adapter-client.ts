import {
  createPrivateKey,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { z } from "zod";

import {
  providerCommandEnvelopeSchema,
  providerExecutionObservationSchema,
  type ProviderCommandEnvelope,
  type ProviderExecutionObservation,
} from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

const ATTESTATION_DOMAIN = "seori-run-attestation-v1\n";
const RESPONSE_LIMIT = 64 * 1024;

export interface ProviderAdapterResult {
  outcome: "COMMAND_ACCEPTED" | "RESULT_UNKNOWN" | "FAILED" | "HUMAN_REQUIRED" | "APPROVAL_REQUIRED";
  errorCode?: string;
}

export interface ProviderAdapterExecutor {
  execute(envelope: ProviderCommandEnvelope): Promise<ProviderAdapterResult>;
  readObservation(envelope: ProviderCommandEnvelope): Promise<ProviderExecutionObservation | null>;
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

function policyActionClass(command: ProviderCommandEnvelope) {
  if (command.operation === "READBACK") return "read_only" as const;
  if (command.operation === "UPLOAD_INTERNAL") return "internal_upload" as const;
  return "other_mutation" as const;
}

export function buildAuthBrokerPolicyGrant(envelope: ProviderCommandEnvelope, subject: string) {
  const command = providerCommandEnvelopeSchema.parse(envelope);
  const request = buildAuthBrokerLeaseRequest(command, subject);
  const id = `provider-grant-${command.bindingHash.slice(0, 40)}-${command.generation}`;
  const commandDigest = jsonDigest(command as unknown as JsonValue);
  const grant = {
    schemaVersion: 1 as const,
    id,
    policyGeneration: command.credential.policyGeneration,
    bindingHash: command.bindingHash,
    commandDigest,
    expiresAt: command.approval.expiresAt,
    maxUses: 1 as const,
    rule: {
      id,
      enabled: true,
      credentialRefs: [request.credentialRef],
      subjects: [request.subject],
      repositories: [request.repository],
      runIds: [request.runId],
      commitShas: [request.commitSha],
      providers: [request.provider],
      origins: [request.origin],
      redirectOrigins: request.redirectOrigins,
      capabilities: [request.capability],
      resources: [request.resource],
      adapters: [request.adapterId],
      accountIds: [request.accountId],
      actionClass: policyActionClass(command),
      authStrategies: [request.authFactors],
      requiresArtifact: request.artifact !== undefined,
      artifactSha256s: request.artifact ? [request.artifact.sha256] : [],
      allowTotp: false,
      approvals: [request.approval],
    },
    command,
  };
  return { grant, digest: jsonDigest(grant as unknown as JsonValue) };
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

const brokerErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/),
  }).strict(),
}).strict();

export function safeBrokerError(body: unknown): string {
  const parsed = brokerErrorResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.error.code : "auth_broker_failed";
}

const REAUTH_ERRORS = new Set([
  "HUMAN_REAUTH_REQUIRED",
  "lease_invalidated_by_reauth",
]);
const APPROVAL_ERRORS = new Set([
  "per_run_approval_required",
  "approval_expired",
  "approval_already_used",
]);

function brokerGateResult(code: string): ProviderAdapterResult | null {
  if (REAUTH_ERRORS.has(code)) return { outcome: "HUMAN_REQUIRED", errorCode: code.toUpperCase() };
  if (APPROVAL_ERRORS.has(code)) return { outcome: "APPROVAL_REQUIRED", errorCode: code.toUpperCase() };
  return null;
}

const policyGrantReferenceSchema = z.object({
  id: z.string().regex(/^provider-grant-[0-9a-f]{40}-[1-9][0-9]*$/),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  bindingHash: z.string().regex(/^[0-9a-f]{64}$/),
  commandDigest: z.string().regex(/^[0-9a-f]{64}$/),
  policyGeneration: z.number().int().positive(),
  state: z.literal("ACTIVE"),
}).strict();

const policyGrantResponseSchema = z.object({ policyGrant: policyGrantReferenceSchema }).strict();
const policyGrantExecutionResponseSchema = z.object({
  policyGrant: policyGrantReferenceSchema,
  execution: z.object({
    generation: z.number().int().positive(),
    outcome: z.enum(["SUCCESS", "ADAPTER_FAILED", "HUMAN_REAUTH_REQUIRED", "RESULT_UNKNOWN"]),
    errorCode: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/).optional(),
  }).strict(),
}).strict();
const policyGrantObservationResponseSchema = z.object({
  policyGrant: policyGrantReferenceSchema,
  observation: providerExecutionObservationSchema,
}).strict();

type PolicyGrantReference = z.infer<typeof policyGrantReferenceSchema>;

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

  #matchesGrantReference(
    reference: PolicyGrantReference,
    expected: ReturnType<typeof buildAuthBrokerPolicyGrant>,
  ): boolean {
    return reference.id === expected.grant.id
      && reference.digest === expected.digest
      && reference.bindingHash === expected.grant.bindingHash
      && reference.commandDigest === expected.grant.commandDigest
      && reference.policyGeneration === expected.grant.policyGeneration;
  }

  #grantExpectation(
    command: ProviderCommandEnvelope,
    built: ReturnType<typeof buildAuthBrokerPolicyGrant>,
  ) {
    return {
      workerId: this.#workerId,
      expectedDigest: built.digest,
      expectedBindingHash: built.grant.bindingHash,
      expectedCommandDigest: built.grant.commandDigest,
      expectedPolicyGeneration: built.grant.policyGeneration,
      expectedExecutionGeneration: command.generation,
    };
  }

  #mapExecutionResponse(
    body: unknown,
    command: ProviderCommandEnvelope,
    built: ReturnType<typeof buildAuthBrokerPolicyGrant>,
  ): ProviderAdapterResult | null {
    const parsed = policyGrantExecutionResponseSchema.safeParse(body);
    if (
      !parsed.success
      || !this.#matchesGrantReference(parsed.data.policyGrant, built)
      || parsed.data.execution.generation !== command.generation
    ) return null;
    const execution = parsed.data.execution;
    if (execution.outcome === "SUCCESS") return { outcome: "COMMAND_ACCEPTED" };
    if (execution.outcome === "ADAPTER_FAILED") {
      return { outcome: "FAILED", errorCode: execution.errorCode ?? "TRUSTED_ADAPTER_FAILED" };
    }
    if (execution.outcome === "HUMAN_REAUTH_REQUIRED") {
      return { outcome: "HUMAN_REQUIRED", errorCode: execution.errorCode ?? "HUMAN_REAUTH_REQUIRED" };
    }
    return { outcome: "RESULT_UNKNOWN", errorCode: "AUTH_BROKER_EXECUTION_UNKNOWN" };
  }

  async #readExecutionResult(
    command: ProviderCommandEnvelope,
    built: ReturnType<typeof buildAuthBrokerPolicyGrant>,
  ): Promise<ProviderAdapterResult> {
    let response;
    try {
      response = await this.#transport({
        path: `/internal/control-plane/provider-grants/${encodeURIComponent(built.grant.id)}/result`,
        body: this.#grantExpectation(command, built),
        attestation: this.#attestation(command),
      });
    } catch {
      return { outcome: "RESULT_UNKNOWN", errorCode: "AUTH_BROKER_EXECUTION_UNKNOWN" };
    }
    if (response.status !== 200) {
      const code = safeBrokerError(response.body);
      return brokerGateResult(code)
        ?? { outcome: "RESULT_UNKNOWN", errorCode: "AUTH_BROKER_EXECUTION_UNKNOWN" };
    }
    return this.#mapExecutionResponse(response.body, command, built)
      ?? { outcome: "RESULT_UNKNOWN", errorCode: "AUTH_BROKER_RESPONSE_INVALID" };
  }

  async #registerAndVerifyPolicyGrant(command: ProviderCommandEnvelope): Promise<
    { grant: ReturnType<typeof buildAuthBrokerPolicyGrant> }
    | { result: ProviderAdapterResult }
  > {
    const built = buildAuthBrokerPolicyGrant(command, this.#subject);
    let registered;
    try {
      registered = await this.#transport({
        path: "/internal/control-plane/provider-grants",
        body: {
          idempotencyKey: `provider-policy-grant:${command.executionId}:${command.generation}`,
          workerId: this.#workerId,
          grant: built.grant,
          digest: built.digest,
        },
        attestation: this.#attestation(command),
      });
    } catch {
      return { result: { outcome: "FAILED", errorCode: "AUTH_BROKER_POLICY_GRANT_UNAVAILABLE" } };
    }
    if (registered.status !== 200 && registered.status !== 201) {
      const code = safeBrokerError(registered.body);
      const gate = brokerGateResult(code);
      if (gate) return { result: gate };
      return {
        result: {
          outcome: "FAILED",
          errorCode: registered.status === 404
            ? "AUTH_BROKER_POLICY_GRANT_UNAVAILABLE"
            : code.toUpperCase(),
        },
      };
    }
    const registeredBody = policyGrantResponseSchema.safeParse(registered.body);
    if (!registeredBody.success || !this.#matchesGrantReference(registeredBody.data.policyGrant, built)) {
      return { result: { outcome: "FAILED", errorCode: "AUTH_BROKER_POLICY_GRANT_INVALID" } };
    }

    let verified;
    try {
      verified = await this.#transport({
        path: `/internal/control-plane/provider-grants/${encodeURIComponent(built.grant.id)}/verify`,
        body: {
          workerId: this.#workerId,
          expectedDigest: built.digest,
          expectedBindingHash: built.grant.bindingHash,
          expectedCommandDigest: built.grant.commandDigest,
          expectedPolicyGeneration: built.grant.policyGeneration,
        },
        attestation: this.#attestation(command),
      });
    } catch {
      return { result: { outcome: "FAILED", errorCode: "AUTH_BROKER_POLICY_GRANT_UNVERIFIED" } };
    }
    if (verified.status !== 200) {
      const code = safeBrokerError(verified.body);
      const gate = brokerGateResult(code);
      if (gate) return { result: gate };
      return { result: { outcome: "FAILED", errorCode: "AUTH_BROKER_POLICY_GRANT_UNVERIFIED" } };
    }
    const verifiedBody = policyGrantResponseSchema.safeParse(verified.body);
    if (!verifiedBody.success || !this.#matchesGrantReference(verifiedBody.data.policyGrant, built)) {
      return { result: { outcome: "FAILED", errorCode: "AUTH_BROKER_POLICY_GRANT_UNVERIFIED" } };
    }
    return { grant: built };
  }

  async execute(envelope: ProviderCommandEnvelope): Promise<ProviderAdapterResult> {
    const command = providerCommandEnvelopeSchema.parse(envelope);
    const policyGrant = await this.#registerAndVerifyPolicyGrant(command);
    if ("result" in policyGrant) return policyGrant.result;
    const built = policyGrant.grant;
    let consumed;
    try {
      consumed = await this.#transport({
        path: `/internal/control-plane/provider-grants/${encodeURIComponent(built.grant.id)}/consume`,
        body: {
          ...this.#grantExpectation(command, built),
          idempotencyKey: `provider-grant-consume:${command.executionId}:${command.generation}`,
        },
        attestation: this.#attestation(command),
      });
    } catch {
      // consume 전송 뒤 응답을 잃었을 수 있으므로 같은 grant를 다시 consume하지 않는다.
      return this.#readExecutionResult(command, built);
    }
    if (consumed.status !== 200) {
      const errorCode = safeBrokerError(consumed.body);
      const gate = brokerGateResult(errorCode);
      if (gate) return gate;
      if (consumed.status >= 500 || errorCode === "auth_broker_failed") {
        return this.#readExecutionResult(command, built);
      }
      return { outcome: "FAILED", errorCode: errorCode.toUpperCase() };
    }
    return this.#mapExecutionResponse(consumed.body, command, built)
      ?? this.#readExecutionResult(command, built);
  }

  async readObservation(envelope: ProviderCommandEnvelope): Promise<ProviderExecutionObservation | null> {
    const command = providerCommandEnvelopeSchema.parse(envelope);
    const built = buildAuthBrokerPolicyGrant(command, this.#subject);
    const response = await this.#transport({
      path: `/internal/control-plane/provider-grants/${encodeURIComponent(built.grant.id)}/observation`,
      body: {
        workerId: this.#workerId,
        expectedDigest: built.digest,
        expectedBindingHash: built.grant.bindingHash,
        expectedCommandDigest: built.grant.commandDigest,
        expectedPolicyGeneration: built.grant.policyGeneration,
        expectedExecutionGeneration: command.generation,
      },
      attestation: this.#attestation(command),
    });
    if (response.status === 204) return null;
    if (response.status !== 200) throw new Error("AUTH_BROKER_OBSERVATION_UNAVAILABLE");
    const parsed = policyGrantObservationResponseSchema.safeParse(response.body);
    if (!parsed.success || !this.#matchesGrantReference(parsed.data.policyGrant, built)) {
      throw new Error("AUTH_BROKER_OBSERVATION_BINDING_MISMATCH");
    }
    return parsed.data.observation;
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
