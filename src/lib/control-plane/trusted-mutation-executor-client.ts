import { randomUUID, type KeyObject } from "node:crypto";
import { z, type ZodType } from "zod";

import { signAgentAdapterAttestation } from "@/lib/control-plane/agent-adapter-attestation";
import type { GithubMutationControlPlane } from "@/lib/control-plane/github-ready-pr-adapter";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { readBoundedResponseBody } from "@/lib/control-plane/mtls-egress-proxy";

const RESPONSE_LIMIT = 3 * 1024 * 1024;
export const TRUSTED_EXECUTOR_HEARTBEAT_INTERVAL_MS = 60_000;

const publicId = z.string().min(1).max(191);

export const trustedExecutorAuthorizationSchema = z.object({
  ok: z.literal(true),
  authorization: z.object({
    executionId: publicId,
    action: z.literal("GITHUB_READY_PR_MUTATE"),
    mutationIntentDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    expectedHeadRef: z.string().startsWith("refs/heads/"),
    expectedPullRequestMarker: publicId,
    expiresAt: z.coerce.date(),
    commitDate: z.coerce.date(),
    status: publicId,
    writeDisposition: z.literal("STEP_LEDGER"),
    duplicate: z.boolean(),
  }).strict(),
}).strict();

export const trustedExecutorRecoverySchema = z.object({
  ok: z.literal(true),
  recovery: z.object({
    executionId: publicId,
    status: publicId,
    repoId: z.string().regex(/^[1-9][0-9]{0,31}$/u),
    repoFullName: z.string().regex(/^seorilabs\/[A-Za-z0-9._-]+$/u),
    issueNumber: z.number().int().positive().nullable(),
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/u),
    expectedHeadRef: z.string().startsWith("refs/heads/"),
    expectedPullRequestMarker: publicId,
    duplicate: z.boolean(),
  }).strict(),
}).strict();

export const trustedExecutorStepSchema = z.object({
  ok: z.literal(true),
  step: z.object({
    executionId: publicId,
    stepId: publicId,
    stepKind: z.enum(["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"]),
    stepStatus: publicId,
    generation: z.number().int().positive(),
    attemptId: publicId.nullable(),
    expiresAt: z.coerce.date().nullable(),
    expectedTreeSha: z.string().regex(/^[0-9a-f]{40}$/u).nullable(),
    expectedCommitSha: z.string().regex(/^[0-9a-f]{40}$/u).nullable(),
    expectedHeadRef: z.string().startsWith("refs/heads/"),
    expectedPullRequestMarker: publicId,
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/u),
    commitDate: z.coerce.date(),
    writeDisposition: z.enum([
      "EXECUTE_ONCE",
      "READBACK_THEN_EXECUTE",
      "READBACK_ONLY",
      "ALREADY_VERIFIED",
    ]),
    duplicate: z.boolean(),
  }).strict(),
}).strict();

export const trustedExecutorPlanSchema = z.object({
  ok: z.literal(true),
  plan: z.object({
    executionId: publicId,
    stepId: publicId,
    attemptId: publicId,
    generation: z.number().int().positive(),
    status: publicId,
    expectedTreeSha: z.string().regex(/^[0-9a-f]{40}$/u),
    expectedCommitSha: z.string().regex(/^[0-9a-f]{40}$/u),
    duplicate: z.boolean(),
  }).strict(),
}).strict();

export const trustedExecutorCompletionSchema = z.object({
  ok: z.literal(true),
  completion: z.object({
    executionId: publicId,
    stepId: publicId,
    attemptId: publicId,
    generation: z.number().int().positive(),
    status: z.enum(["VERIFIED", "NOT_APPLIED", "RESULT_UNKNOWN"]),
    duplicate: z.boolean(),
  }).strict(),
}).strict();

export const trustedExecutorReadbackSchema = z.object({
  ok: z.literal(true),
  readback: z.object({
    executionId: publicId,
    status: z.enum(["VERIFIED", "NOT_APPLIED", "RESULT_UNKNOWN"]),
    duplicate: z.boolean(),
  }).strict(),
}).strict();

export const trustedExecutorSettlementSchema = z.object({
  ok: z.literal(true),
  settlement: z.object({
    runId: publicId,
    status: publicId,
    duplicate: z.boolean(),
    retry: z.boolean().optional(),
  }).strict(),
}).strict();

export const trustedExecutorHeartbeatSchema = z.object({
  ok: z.literal(true),
  heartbeat: z.object({
    sessionId: publicId,
    generation: z.number().int().positive(),
    expiresAt: z.coerce.date(),
    duplicate: z.boolean(),
  }).strict(),
}).strict();

export function trustedExecutorClaimSchema<Task>(taskSchema: ZodType<Task>) {
  return z.object({
    ok: z.literal(true),
    claim: z.object({
      sessionId: publicId,
      runId: publicId,
      generation: z.number().int().positive(),
      resumeMode: z.enum(["START", "READBACK_FIRST"]),
      expiresAt: z.coerce.date(),
      task: taskSchema,
    }).strict().nullable(),
  }).strict();
}

export type TrustedExecutorCall = (body: unknown, requestId: string) => Promise<unknown>;

function publicJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/**
 * 실행기 → Backoffice 호출 경계다. bearer만으로는 실행 runtime을 증명하지 못하므로 매
 * 요청에 route/body Ed25519 attestation을 붙인다.
 */
export function createTrustedExecutorCall(input: {
  route: string;
  backofficeOrigin: URL;
  adapterPrincipalId: string;
  adapterRuntimeIdentity: string;
  bearer: string;
  attestationKey: KeyObject;
  fetchImpl: typeof globalThis.fetch;
  responseTooLargeCode: string;
}): TrustedExecutorCall {
  return async (rawBody, requestId) => {
    const body = publicJson(rawBody);
    const issuedAt = Date.now();
    const attestation = signAgentAdapterAttestation({
      privateKey: input.attestationKey,
      runtimeIdentity: input.adapterRuntimeIdentity,
      route: input.route,
      requestId,
      body,
      issuedAt,
      expiresAt: issuedAt + 30_000,
      nonce: randomUUID(),
    });
    const encoded = Buffer.from(JSON.stringify(body), "utf8");
    let response: Response;
    try {
      response = await input.fetchImpl(new URL(input.route, input.backofficeOrigin), {
        method: "POST",
        body: encoded,
        signal: AbortSignal.timeout(20_000),
        headers: {
          "content-type": "application/json",
          "content-length": String(encoded.length),
          authorization: `Bearer ${input.bearer}`,
          "x-seori-principal": input.adapterPrincipalId,
          "x-seori-adapter-attestation": attestation,
          "idempotency-key": requestId,
        },
      });
    } finally {
      encoded.fill(0);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`SEORI_BACKOFFICE_REJECTED_${response.status}`);
    }
    const payload = await readBoundedResponseBody(response, RESPONSE_LIMIT, input.responseTooLargeCode);
    try {
      return JSON.parse(payload.toString("utf8"));
    } finally {
      payload.fill(0);
    }
  };
}

/** adapter가 구현하는 중앙 step ledger 경계다. 실행기마다 route만 다르고 형태는 같다. */
export function trustedExecutorControlPlane(input: {
  call: TrustedExecutorCall;
  captureExecutionId: (executionId: string) => void;
}): GithubMutationControlPlane {
  return {
    recover: async ({ requestId, body }) => trustedExecutorRecoverySchema.parse(await input.call({
      operation: "RECOVERY",
      sessionId: body.sessionId,
    }, requestId)).recovery,
    authorize: async ({ requestId, body }) => {
      const authorization = trustedExecutorAuthorizationSchema.parse(await input.call({
        operation: "AUTHORIZE",
        sessionId: body.sessionId,
        mutationIntentDigest: body.mutationIntentDigest,
        observation: body.observation,
      }, requestId)).authorization;
      input.captureExecutionId(authorization.executionId);
      return authorization;
    },
    claimStep: async ({ requestId, body }) => trustedExecutorStepSchema.parse(await input.call({
      operation: "STEP_CLAIM",
      sessionId: body.sessionId,
      executionId: body.executionId,
      stepKind: body.stepKind,
    }, requestId)).step,
    planStep: async ({ requestId, body }) => trustedExecutorPlanSchema.parse(await input.call({
      operation: "STEP_PLAN",
      sessionId: body.sessionId,
      executionId: body.executionId,
      stepId: body.stepId,
      attemptId: body.attemptId,
      generation: body.generation,
      expectedTreeSha: body.expectedTreeSha,
      expectedCommitSha: body.expectedCommitSha,
    }, requestId)).plan,
    completeStep: async ({ requestId, body }) => trustedExecutorCompletionSchema.parse(await input.call({
      operation: "STEP_COMPLETE",
      sessionId: body.sessionId,
      executionId: body.executionId,
      stepId: body.stepId,
      attemptId: body.attemptId,
      generation: body.generation,
      stepKind: body.stepKind,
      observation: body.observation,
    }, requestId)).completion,
    readback: async ({ requestId, body }) => trustedExecutorReadbackSchema.parse(await input.call({
      operation: "READBACK",
      sessionId: body.sessionId,
      executionId: body.executionId,
      observation: body.observation,
    }, requestId)).readback,
  };
}

export async function settleTrustedExecutorRun(input: {
  call: TrustedExecutorCall;
  requestPrefix: string;
  podUid: string;
  sessionId: string;
  mode: "START" | "READBACK_FIRST";
  status: "VERIFIED" | "NOT_APPLIED" | "PARTIAL_VERIFIED" | "RESULT_UNKNOWN" | "FAILED";
  executionId: string | null;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  errorCode?: string;
}) {
  return trustedExecutorSettlementSchema.parse(await input.call({
    operation: "SETTLE",
    sessionId: input.sessionId,
    mode: input.mode,
    status: input.status,
    executionId: input.executionId,
    pullRequestNumber: input.pullRequestNumber ?? null,
    pullRequestUrl: input.pullRequestUrl ?? null,
    commitSha: null,
    errorCode: input.errorCode ?? null,
  }, `${input.requestPrefix}:${jsonDigest({
    podUid: input.podUid,
    sessionId: input.sessionId,
    operation: "settle",
    status: input.status,
  })}`)).settlement;
}

/**
 * lease가 만료되면 다른 pod가 같은 run을 이어받아 중복 write가 생긴다. heartbeat 실패는
 * 즉시 다음 중앙 호출에서 터뜨려 write를 멈춘다.
 */
export function startTrustedExecutorHeartbeat(input: {
  call: TrustedExecutorCall;
  requestPrefix: string;
  podUid: string;
  sessionId: string;
  generation: number;
}) {
  let sequence = 0;
  let failure: unknown = null;
  let chain: Promise<void> = Promise.resolve();
  const beat = async () => {
    sequence += 1;
    const response = trustedExecutorHeartbeatSchema.parse(await input.call({
      operation: "HEARTBEAT",
      sessionId: input.sessionId,
      generation: input.generation,
    }, `${input.requestPrefix}:${jsonDigest({
      podUid: input.podUid,
      sessionId: input.sessionId,
      generation: input.generation,
      operation: "heartbeat",
      sequence,
    })}`)).heartbeat;
    if (response.sessionId !== input.sessionId || response.generation !== input.generation) {
      throw new Error("TRUSTED_EXECUTOR_HEARTBEAT_BINDING_MISMATCH");
    }
  };
  return {
    start: async () => {
      await beat();
      const timer = setInterval(() => {
        chain = chain.then(beat).catch((error: unknown) => { failure = error; });
      }, TRUSTED_EXECUTOR_HEARTBEAT_INTERVAL_MS);
      timer.unref();
      return timer;
    },
    guard: (call: TrustedExecutorCall): TrustedExecutorCall => async (body, requestId) => {
      if (failure) throw failure;
      return call(body, requestId);
    },
    settled: async () => {
      await chain;
      if (failure) throw failure;
    },
    failure: () => failure,
  };
}

export function publicExecutorError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{7,190}$/u.test(message) || message.startsWith("SEORI_BACKOFFICE_REJECTED_")
    ? message
    : fallback;
}

/**
 * 실행기는 공개 코드가 아닌 오류를 밖으로 내보내지 않는다. 그래서 단계 정보가 없으면
 * 어느 경계에서 멈췄는지 알 수 없다. 원문은 감추되 단계 이름만 공개 코드로 승격한다.
 * 내부에서 이미 공개 코드가 나오면 그 코드를 그대로 보존한다.
 */
export async function withExecutorStage<Result>(
  prefix: string,
  name: string,
  run: () => Promise<Result>,
): Promise<Result> {
  try {
    return await run();
  } catch (error) {
    const known = publicExecutorError(error, "");
    throw new Error(known || `${prefix}_STAGE_${name}_FAILED`);
  }
}
