import { z } from "zod";

import {
  providerCommandEnvelopeSchema,
  providerExecutionObservationSchema,
  type ProviderCommandEnvelope,
  type ProviderExecutionObservation,
} from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

export interface ProviderAdapterResult {
  outcome: "COMMAND_ACCEPTED" | "RESULT_UNKNOWN" | "FAILED" | "HUMAN_REQUIRED" | "APPROVAL_REQUIRED";
  errorCode?: string;
}

export interface ProviderAdapterExecutor {
  execute(envelope: ProviderCommandEnvelope): Promise<ProviderAdapterResult>;
  readObservation(envelope: ProviderCommandEnvelope): Promise<ProviderExecutionObservation | null>;
}

/** worker가 durable claim의 resume mode를 무시하지 못하게 하는 단일 dispatch 경계다. */
export function executeProviderAdapterClaim(
  adapter: ProviderAdapterExecutor,
  claim: {
    executionId: string;
    generation: number;
    resumeMode: "START" | "READBACK_FIRST";
    envelope: ProviderCommandEnvelope;
  },
): Promise<ProviderAdapterResult> {
  const command = providerCommandEnvelopeSchema.parse(claim.envelope);
  if (
    command.executionId !== claim.executionId
    || command.generation !== claim.generation
    || command.resumeMode !== claim.resumeMode
  ) {
    throw new Error("PROVIDER_CLAIM_BINDING_MISMATCH");
  }
  if (claim.resumeMode === "READBACK_FIRST") {
    if (command.operation !== "READBACK") throw new Error("PROVIDER_READBACK_COMMAND_INVALID");
  }
  return adapter.execute(command);
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

export type BrokerTransport = (input: ProviderBrokerRequest) => Promise<{ status: number; body: unknown }>;

export const providerBrokerStageSchema = z.enum([
  "REGISTER",
  "VERIFY",
  "CONSUME",
  "RESULT",
  "OBSERVATION",
]);
export type ProviderBrokerStage = z.infer<typeof providerBrokerStageSchema>;

export type ProviderBrokerRequest = {
  executionId: string;
  generation: number;
  stage: ProviderBrokerStage;
  ordinal: number;
  path: string;
  body: Record<string, unknown>;
};

/**
 * Worker가 임의 route/body를 고르지 못하도록 signer와 adapter가 공유하는 exact request builder다.
 * signer는 durable RUNNING claim에서 envelope을 다시 구성한 뒤 이 결과만 broker로 전송한다.
 */
export function buildProviderBrokerRequest(input: {
  envelope: ProviderCommandEnvelope;
  subject: string;
  workerId: string;
  stage: ProviderBrokerStage;
  ordinal?: number;
}): ProviderBrokerRequest {
  const command = providerCommandEnvelopeSchema.parse(input.envelope);
  const built = buildAuthBrokerPolicyGrant(command, input.subject);
  const expectation = {
    workerId: input.workerId,
    expectedDigest: built.digest,
    expectedBindingHash: built.grant.bindingHash,
    expectedCommandDigest: built.grant.commandDigest,
    expectedPolicyGeneration: built.grant.policyGeneration,
  };
  const ordinal = input.ordinal ?? 1;
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 20) {
    throw new Error("PROVIDER_BROKER_REQUEST_ORDINAL_INVALID");
  }
  if (input.stage !== "OBSERVATION" && ordinal !== 1) {
    throw new Error("PROVIDER_BROKER_REQUEST_REPLAY_FORBIDDEN");
  }
  if (input.stage === "REGISTER") {
    return {
      executionId: command.executionId,
      generation: command.generation,
      stage: input.stage,
      ordinal,
      path: "/internal/control-plane/provider-grants",
      body: {
        idempotencyKey: `provider-policy-grant:${command.executionId}:${command.generation}`,
        workerId: input.workerId,
        grant: built.grant,
        digest: built.digest,
      },
    };
  }
  const grantPath = `/internal/control-plane/provider-grants/${encodeURIComponent(built.grant.id)}`;
  if (input.stage === "VERIFY") {
    return {
      executionId: command.executionId,
      generation: command.generation,
      stage: input.stage,
      ordinal,
      path: `${grantPath}/verify`,
      body: expectation,
    };
  }
  const executionExpectation = {
    ...expectation,
    expectedExecutionGeneration: command.generation,
  };
  if (input.stage === "CONSUME") {
    return {
      executionId: command.executionId,
      generation: command.generation,
      stage: input.stage,
      ordinal,
      path: `${grantPath}/consume`,
      body: {
        ...executionExpectation,
        idempotencyKey: `provider-grant-consume:${command.executionId}:${command.generation}`,
      },
    };
  }
  return {
    executionId: command.executionId,
    generation: command.generation,
    stage: input.stage,
    ordinal,
    path: `${grantPath}/${input.stage === "RESULT" ? "result" : "observation"}`,
    body: executionExpectation,
  };
}

export function providerBrokerRequestDigest(request: Pick<ProviderBrokerRequest, "path" | "body">): string {
  return jsonDigest({ path: request.path, body: request.body } as JsonValue);
}

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

/**
 * Signer가 broker 응답을 worker로 넘기기 전에 공개 계약만 남긴다. provider/TLS 오류 원문이나
 * 잘못 구현된 adapter의 secret-like 추가 필드는 worker process에 도달하지 않는다.
 */
export function sanitizeProviderBrokerResponse(
  stage: ProviderBrokerStage,
  response: { status: number; body: unknown },
): { status: number; body: unknown } {
  if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) {
    return { status: 502, body: { error: { code: "auth_broker_response_invalid" } } };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      status: response.status,
      body: { error: { code: safeBrokerError(response.body) } },
    };
  }
  if (stage === "OBSERVATION" && response.status === 204) {
    return { status: 204, body: null };
  }
  const parsed = stage === "REGISTER" || stage === "VERIFY"
    ? policyGrantResponseSchema.safeParse(response.body)
    : stage === "OBSERVATION"
      ? policyGrantObservationResponseSchema.safeParse(response.body)
      : policyGrantExecutionResponseSchema.safeParse(response.body);
  return parsed.success
    ? { status: response.status, body: parsed.data }
    : { status: 502, body: { error: { code: "auth_broker_response_invalid" } } };
}

type PolicyGrantReference = z.infer<typeof policyGrantReferenceSchema>;

export class SeoriAuthBrokerProviderAdapter implements ProviderAdapterExecutor {
  readonly #workerId: string;
  readonly #subject: string;
  readonly #transport: BrokerTransport;
  readonly #observationOrdinals = new Map<string, number>();
  readonly #executedReadbacks = new Set<string>();

  constructor(input: {
    workerId: string;
    subject: string;
    transport: BrokerTransport;
  }) {
    this.#workerId = input.workerId;
    this.#subject = input.subject;
    this.#transport = input.transport;
  }

  #request(command: ProviderCommandEnvelope, stage: ProviderBrokerStage, ordinal = 1) {
    return buildProviderBrokerRequest({
      envelope: command,
      subject: this.#subject,
      workerId: this.#workerId,
      stage,
      ordinal,
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
      response = await this.#transport(this.#request(command, "RESULT"));
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
      registered = await this.#transport(this.#request(command, "REGISTER"));
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
      verified = await this.#transport(this.#request(command, "VERIFY"));
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
    if ("result" in policyGrant) return this.#recordExecutedReadback(command, policyGrant.result);
    const built = policyGrant.grant;
    let consumed;
    try {
      consumed = await this.#transport(this.#request(command, "CONSUME"));
    } catch {
      // consume 전송 뒤 응답을 잃었을 수 있으므로 같은 grant를 다시 consume하지 않는다.
      return this.#recordExecutedReadback(command, await this.#readExecutionResult(command, built));
    }
    if (consumed.status !== 200) {
      const errorCode = safeBrokerError(consumed.body);
      const gate = brokerGateResult(errorCode);
      if (gate) return this.#recordExecutedReadback(command, gate);
      if (consumed.status >= 500 || errorCode === "auth_broker_failed") {
        return this.#recordExecutedReadback(command, await this.#readExecutionResult(command, built));
      }
      return this.#recordExecutedReadback(command, { outcome: "FAILED", errorCode: errorCode.toUpperCase() });
    }
    const result = this.#mapExecutionResponse(consumed.body, command, built)
      ?? await this.#readExecutionResult(command, built);
    return this.#recordExecutedReadback(command, result);
  }

  #recordExecutedReadback(command: ProviderCommandEnvelope, result: ProviderAdapterResult) {
    if (command.operation === "READBACK" && result.outcome === "COMMAND_ACCEPTED") {
      this.#executedReadbacks.add(`${command.executionId}:${command.generation}`);
    }
    return result;
  }

  async readObservation(envelope: ProviderCommandEnvelope): Promise<ProviderExecutionObservation | null> {
    const command = providerCommandEnvelopeSchema.parse(envelope);
    const observationKey = `${command.executionId}:${command.generation}`;
    if (command.operation !== "READBACK" || !this.#executedReadbacks.has(observationKey)) {
      throw new Error("AUTH_BROKER_READBACK_NOT_EXECUTED");
    }
    const built = buildAuthBrokerPolicyGrant(command, this.#subject);
    const ordinal = (this.#observationOrdinals.get(observationKey) ?? 0) + 1;
    this.#observationOrdinals.set(observationKey, ordinal);
    const response = await this.#transport(this.#request(command, "OBSERVATION", ordinal));
    if (response.status === 204) return null;
    if (response.status !== 200) throw new Error("AUTH_BROKER_OBSERVATION_UNAVAILABLE");
    const parsed = policyGrantObservationResponseSchema.safeParse(response.body);
    if (!parsed.success || !this.#matchesGrantReference(parsed.data.policyGrant, built)) {
      throw new Error("AUTH_BROKER_OBSERVATION_BINDING_MISMATCH");
    }
    return parsed.data.observation;
  }
}
