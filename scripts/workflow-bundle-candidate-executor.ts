import { createPrivateKey, randomUUID, type KeyObject } from "node:crypto";
import { z } from "zod";

import {
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
} from "@/lib/control-plane/automation-catalog";
import {
  WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_PRINCIPAL,
  WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_RUNTIME_IDENTITY,
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_ATTESTATION_ROUTE,
} from "@/lib/control-plane/trusted-executor-bindings";
import { signAgentAdapterAttestation } from "@/lib/control-plane/agent-adapter-attestation";
import {
  executeWorkflowBundleCandidateReadyPr,
  recoverGithubReadyPr,
  type GithubMutationControlPlane,
} from "@/lib/control-plane/github-ready-pr-adapter";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  createExactMtlsProxyClient,
  exactHostSet,
  readBoundedResponseBody,
} from "@/lib/control-plane/mtls-egress-proxy";
import {
  workflowBundleCandidateTaskSchema,
  type WorkflowBundleCandidateTask,
} from "@/lib/control-plane/workflow-bundle-candidate-contract";
import {
  parseExactHttpsOrigin,
  readBoundSecretFile,
  withBoundSecretText,
} from "@/lib/control-plane/seori-auth-agent-transport";
import { withGithubReadyPrInstallation } from "@/lib/github/ready-pr-installation-client";

const FIXED_ROOT = process.env.WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_ROOT?.trim()
  || "/var/run/workflow-bundle-candidate-executor";
const ROUTE = WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_ATTESTATION_ROUTE;
const RESPONSE_LIMIT = 3 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 60_000;
const backofficeOrigin = parseExactHttpsOrigin(process.env.SEORI_BACKOFFICE_ORIGIN?.trim() || "");
const adapterPrincipalId = process.env.WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_PRINCIPAL?.trim() || "";
const adapterRuntimeIdentity = process.env.WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_RUNTIME_IDENTITY?.trim() || "";
const podUid = process.env.WORKFLOW_BUNDLE_CANDIDATE_EXECUTION_ID?.trim() || "";
if (adapterPrincipalId !== WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_PRINCIPAL) throw new Error("CANDIDATE_ADAPTER_PRINCIPAL_INVALID");
if (adapterRuntimeIdentity !== WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_RUNTIME_IDENTITY) throw new Error("CANDIDATE_ADAPTER_RUNTIME_INVALID");
if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,190}$/u.test(podUid)) throw new Error("CANDIDATE_EXECUTION_ID_INVALID");

const publicId = z.string().min(1).max(191);
const claimSchema = z.object({
  ok: z.literal(true),
  claim: z.object({
    sessionId: publicId,
    runId: publicId,
    generation: z.number().int().positive(),
    resumeMode: z.enum(["START", "READBACK_FIRST"]),
    expiresAt: z.coerce.date(),
    task: workflowBundleCandidateTaskSchema,
  }).strict().nullable(),
}).strict();
const authorizationSchema = z.object({
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
const recoverySchema = z.object({
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
const stepSchema = z.object({
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
    writeDisposition: z.enum(["EXECUTE_ONCE", "READBACK_THEN_EXECUTE", "READBACK_ONLY", "ALREADY_VERIFIED"]),
    duplicate: z.boolean(),
  }).strict(),
}).strict();
const planSchema = z.object({
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
const completionSchema = z.object({
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
const readbackSchema = z.object({
  ok: z.literal(true),
  readback: z.object({
    executionId: publicId,
    status: z.enum(["VERIFIED", "NOT_APPLIED", "RESULT_UNKNOWN"]),
    duplicate: z.boolean(),
  }).strict(),
}).strict();
const settlementSchema = z.object({
  ok: z.literal(true),
  settlement: z.object({
    runId: publicId,
    status: publicId,
    duplicate: z.boolean(),
    retry: z.boolean().optional(),
  }).strict(),
}).strict();
const heartbeatSchema = z.object({
  ok: z.literal(true),
  heartbeat: z.object({
    sessionId: publicId,
    generation: z.number().int().positive(),
    expiresAt: z.coerce.date(),
    duplicate: z.boolean(),
  }).strict(),
}).strict();

function publicJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function callBackoffice(input: {
  body: JsonValue;
  requestId: string;
  bearer: string;
  attestationKey: KeyObject;
  fetchImpl: typeof globalThis.fetch;
}): Promise<unknown> {
  const issuedAt = Date.now();
  const attestation = signAgentAdapterAttestation({
    privateKey: input.attestationKey,
    runtimeIdentity: adapterRuntimeIdentity,
    route: ROUTE,
    requestId: input.requestId,
    body: input.body,
    issuedAt,
    expiresAt: issuedAt + 30_000,
    nonce: randomUUID(),
  });
  return (async () => {
    const encoded = Buffer.from(JSON.stringify(input.body), "utf8");
    let response: Response;
    try {
      response = await input.fetchImpl(new URL(ROUTE, backofficeOrigin), {
        method: "POST",
        body: encoded,
        signal: AbortSignal.timeout(20_000),
        headers: {
          "content-type": "application/json",
          "content-length": String(encoded.length),
          authorization: `Bearer ${input.bearer}`,
          "x-seori-principal": adapterPrincipalId,
          "x-seori-adapter-attestation": attestation,
          "idempotency-key": input.requestId,
        },
      });
    } finally {
      encoded.fill(0);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`SEORI_BACKOFFICE_REJECTED_${response.status}`);
    }
    const payload = await readBoundedResponseBody(
      response,
      RESPONSE_LIMIT,
      "CANDIDATE_BACKOFFICE_RESPONSE_TOO_LARGE",
    );
    try {
      return JSON.parse(payload.toString("utf8"));
    } finally {
      payload.fill(0);
    }
  })();
}

function requestClient(input: {
  bearer: string;
  attestationKey: KeyObject;
  fetchImpl: typeof globalThis.fetch;
}) {
  return (body: unknown, requestId: string) => callBackoffice({
    ...input,
    body: publicJson(body),
    requestId,
  });
}

function controlPlaneFor(input: {
  call: ReturnType<typeof requestClient>;
  captureExecutionId: (executionId: string) => void;
}): GithubMutationControlPlane {
  return {
    recover: async ({ requestId, body }) => recoverySchema.parse(await input.call({
      operation: "RECOVERY",
      sessionId: body.sessionId,
    }, requestId)).recovery,
    authorize: async ({ requestId, body }) => {
      const authorization = authorizationSchema.parse(await input.call({
        operation: "AUTHORIZE",
        sessionId: body.sessionId,
        mutationIntentDigest: body.mutationIntentDigest,
        observation: body.observation,
      }, requestId)).authorization;
      input.captureExecutionId(authorization.executionId);
      return authorization;
    },
    claimStep: async ({ requestId, body }) => stepSchema.parse(await input.call({
      operation: "STEP_CLAIM",
      sessionId: body.sessionId,
      executionId: body.executionId,
      stepKind: body.stepKind,
    }, requestId)).step,
    planStep: async ({ requestId, body }) => planSchema.parse(await input.call({
      operation: "STEP_PLAN",
      sessionId: body.sessionId,
      executionId: body.executionId,
      stepId: body.stepId,
      attemptId: body.attemptId,
      generation: body.generation,
      expectedTreeSha: body.expectedTreeSha,
      expectedCommitSha: body.expectedCommitSha,
    }, requestId)).plan,
    completeStep: async ({ requestId, body }) => completionSchema.parse(await input.call({
      operation: "STEP_COMPLETE",
      sessionId: body.sessionId,
      executionId: body.executionId,
      stepId: body.stepId,
      attemptId: body.attemptId,
      generation: body.generation,
      stepKind: body.stepKind,
      observation: body.observation,
    }, requestId)).completion,
    readback: async ({ requestId, body }) => readbackSchema.parse(await input.call({
      operation: "READBACK",
      sessionId: body.sessionId,
      executionId: body.executionId,
      observation: body.observation,
    }, requestId)).readback,
  };
}

async function settle(input: {
  call: ReturnType<typeof requestClient>;
  sessionId: string;
  mode: "START" | "READBACK_FIRST";
  status: "VERIFIED" | "NOT_APPLIED" | "PARTIAL_VERIFIED" | "RESULT_UNKNOWN" | "FAILED";
  executionId: string | null;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  errorCode?: string;
}) {
  return settlementSchema.parse(await input.call({
    operation: "SETTLE",
    sessionId: input.sessionId,
    mode: input.mode,
    status: input.status,
    executionId: input.executionId,
    pullRequestNumber: input.pullRequestNumber ?? null,
    pullRequestUrl: input.pullRequestUrl ?? null,
    commitSha: null,
    errorCode: input.errorCode ?? null,
  }, `wbc:${jsonDigest({ podUid, sessionId: input.sessionId, operation: "settle", status: input.status })}`)).settlement;
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{7,190}$/u.test(message)
    ? message
    : message.startsWith("SEORI_BACKOFFICE_REJECTED_")
      ? message
      : "WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_FAILED";
}

async function runWithSecrets(input: {
  bearer: string;
  attestationKey: KeyObject;
  backofficeFetch: typeof globalThis.fetch;
  githubFetch: typeof globalThis.fetch;
}) {
  const call = requestClient({
    bearer: input.bearer,
    attestationKey: input.attestationKey,
    fetchImpl: input.backofficeFetch,
  });
  const claimRequestId = `wbc:${jsonDigest({ podUid, operation: "claim" })}`;
  const claim = claimSchema.parse(await call({ operation: "CLAIM" }, claimRequestId)).claim;
  if (!claim) {
    console.log("[workflow-bundle-candidate-executor] no claim");
    return;
  }
  let heartbeatSequence = 0;
  let heartbeatError: unknown = null;
  let heartbeatChain: Promise<void> = Promise.resolve();
  const heartbeat = async () => {
    heartbeatSequence += 1;
    const response = heartbeatSchema.parse(await call({
      operation: "HEARTBEAT",
      sessionId: claim.sessionId,
      generation: claim.generation,
    }, `wbc:${jsonDigest({
      podUid,
      sessionId: claim.sessionId,
      generation: claim.generation,
      operation: "heartbeat",
      sequence: heartbeatSequence,
    })}`)).heartbeat;
    if (response.sessionId !== claim.sessionId || response.generation !== claim.generation) {
      throw new Error("CANDIDATE_HEARTBEAT_BINDING_MISMATCH");
    }
  };
  await heartbeat();
  const heartbeatTimer = setInterval(() => {
    heartbeatChain = heartbeatChain.then(heartbeat).catch((error: unknown) => {
      heartbeatError = error;
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
  const guardedCall: ReturnType<typeof requestClient> = async (body, requestId) => {
    if (heartbeatError) throw heartbeatError;
    return call(body, requestId);
  };
  let executionId: string | null = null;
  const workerRuntimeBindingDigest = jsonDigest({
    schemaVersion: 1,
    principal: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    adapterPrincipalId,
    adapterRuntimeIdentity,
    workload: "workflow-bundle-candidate-executor",
  });
  const controlPlane = controlPlaneFor({
    call: guardedCall,
    captureExecutionId: (value) => { executionId = value; },
  });
  try {
    const result = await withGithubReadyPrInstallation({
      installationId: claim.task.github.installationId,
      repositoryId: claim.task.repository.id,
      repositoryFullName: claim.task.repository.fullName,
      capability: "github.workflow-bundle-candidate.ready-pr",
      requestFetch: input.githubFetch,
      execute: async (github) => claim.resumeMode === "START"
        ? executeWorkflowBundleCandidateReadyPr({
            operationId: claim.sessionId,
            workerPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
            workerRuntimeBindingDigest,
            task: claim.task as WorkflowBundleCandidateTask,
            sessionId: claim.sessionId,
            github,
            controlPlane,
          })
        : (async () => {
            const recovery = await controlPlane.recover({
              requestId: `wbc:${jsonDigest({ podUid, runId: claim.runId, operation: "recovery" })}`,
              body: {
                sessionId: claim.sessionId,
                workerPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
                workerRuntimeBindingDigest,
              },
            });
            executionId = recovery.executionId;
            return recoverGithubReadyPr({
              operationId: claim.sessionId,
              sessionId: claim.sessionId,
              workerPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
              workerRuntimeBindingDigest,
              recovery,
              github,
              controlPlane,
            });
          })(),
    });
    clearInterval(heartbeatTimer);
    await heartbeatChain;
    if (heartbeatError) throw heartbeatError;
    const settlementStatus = claim.resumeMode === "READBACK_FIRST"
      && result.status === "RESULT_UNKNOWN"
      && "safeToResume" in result
      && result.safeToResume
      ? "PARTIAL_VERIFIED" as const
      : result.status;
    await settle({
      call,
      sessionId: claim.sessionId,
      mode: claim.resumeMode,
      status: settlementStatus,
      executionId: result.executionId,
      pullRequestNumber: result.pullRequestNumber,
      pullRequestUrl: result.pullRequestUrl,
    });
    console.log(`[workflow-bundle-candidate-executor] settled status=${settlementStatus}`);
  } catch (error) {
    clearInterval(heartbeatTimer);
    await heartbeatChain;
    const code = publicError(error);
    await settle({
      call,
      sessionId: claim.sessionId,
      mode: claim.resumeMode,
      status: executionId ? "RESULT_UNKNOWN" : "FAILED",
      executionId,
      errorCode: code,
    });
    throw new Error(code);
  }
}

async function main() {
  const ca = await readBoundSecretFile({
    root: FIXED_ROOT,
    relativePath: "backoffice/ca.pem",
    allowGroupRead: true,
  });
  const keyBytes = await readBoundSecretFile({
    root: FIXED_ROOT,
    relativePath: "adapter/attestation-private.pem",
    allowGroupRead: true,
  });
  const attestationKey = createPrivateKey(keyBytes);
  keyBytes.fill(0);
  if (attestationKey.asymmetricKeyType !== "ed25519") throw new Error("CANDIDATE_ATTESTATION_KEY_INVALID");
  const proxyBinding = {
    root: FIXED_ROOT,
    proxyOrigin: process.env.SEORI_EGRESS_PROXY_ORIGIN?.trim() || "",
    proxyServerName: process.env.SEORI_EGRESS_PROXY_SERVER_NAME?.trim() || "",
  };
  const backofficeEgress = await createExactMtlsProxyClient({
    ...proxyBinding,
    allowedHosts: exactHostSet("backoffice.vzyx.xyz"),
    targetCa: ca,
  });
  let githubEgress: Awaited<ReturnType<typeof createExactMtlsProxyClient>>;
  try {
    githubEgress = await createExactMtlsProxyClient({
      ...proxyBinding,
      allowedHosts: exactHostSet("api.github.com"),
    });
  } catch (error) {
    await backofficeEgress.close();
    throw error;
  }
  try {
    await withBoundSecretText({
      root: FIXED_ROOT,
      relativePath: "backoffice/adapter.bearer",
      allowGroupRead: true,
      maxBytes: 4096,
    }, (bearer) => runWithSecrets({
      bearer,
      attestationKey,
      backofficeFetch: backofficeEgress.fetch,
      githubFetch: githubEgress.fetch,
    }));
  } finally {
    await Promise.all([backofficeEgress.close(), githubEgress.close()]);
    ca.fill(0);
  }
}

main().catch((error) => {
  console.error(`[workflow-bundle-candidate-executor] 종료 code=${publicError(error)}`);
  process.exitCode = 1;
});
