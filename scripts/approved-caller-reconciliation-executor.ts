import { createPrivateKey, type KeyObject } from "node:crypto";
import { z } from "zod";

import { APPROVED_CALLER_RECONCILIATION_EXECUTOR_PRINCIPAL } from "@/lib/control-plane/automation-catalog";
import {
  generateApprovedCallerMutation,
  loadWorkflowBundleV5Contract,
  withTargetRepositoryCheckout,
  type ApprovedBundleVerification,
} from "@/lib/control-plane/approved-caller-generator";
import {
  approvedCallerReconciliationCommand,
  approvedCallerReconciliationTaskSchema,
} from "@/lib/control-plane/approved-caller-reconciliation-contract";
import {
  executePreparedGithubReadyPr,
  recoverGithubReadyPr,
  type GithubReadyPrCommand,
} from "@/lib/control-plane/github-ready-pr-adapter";
import { jsonDigest } from "@/lib/control-plane/json";
import {
  createExactMtlsProxyClient,
  exactHostSet,
} from "@/lib/control-plane/mtls-egress-proxy";
import {
  createTrustedExecutorCall,
  publicExecutorError,
  settleTrustedExecutorRun,
  startTrustedExecutorHeartbeat,
  trustedExecutorClaimSchema,
  trustedExecutorControlPlane,
  type TrustedExecutorCall,
} from "@/lib/control-plane/trusted-mutation-executor-client";
import {
  APPROVED_CALLER_RECONCILIATION_ADAPTER_PRINCIPAL,
  APPROVED_CALLER_RECONCILIATION_ADAPTER_RUNTIME_IDENTITY,
  APPROVED_CALLER_RECONCILIATION_EXECUTOR_ATTESTATION_ROUTE,
} from "@/lib/control-plane/trusted-executor-bindings";
import {
  parseExactHttpsOrigin,
  readBoundSecretFile,
  withBoundSecretText,
} from "@/lib/control-plane/seori-auth-agent-transport";
import { withGithubReadyPrInstallation } from "@/lib/github/ready-pr-installation-client";
import { getFleetScopedGithubTokenIssuer } from "@/lib/github/app";
import { withFleetScopedGithubToken } from "@/lib/github/scoped-installation-client";

const FIXED_ROOT = process.env.APPROVED_CALLER_RECONCILIATION_EXECUTOR_ROOT?.trim()
  || "/var/run/approved-caller-reconciliation-executor";
const ROUTE = APPROVED_CALLER_RECONCILIATION_EXECUTOR_ATTESTATION_ROUTE;
const REQUEST_PREFIX = "acr";
const FAILED = "APPROVED_CALLER_RECONCILIATION_EXECUTOR_FAILED";
const backofficeOrigin = parseExactHttpsOrigin(process.env.SEORI_BACKOFFICE_ORIGIN?.trim() || "");
const adapterPrincipalId = process.env.APPROVED_CALLER_RECONCILIATION_ADAPTER_PRINCIPAL?.trim() || "";
const adapterRuntimeIdentity =
  process.env.APPROVED_CALLER_RECONCILIATION_ADAPTER_RUNTIME_IDENTITY?.trim() || "";
const podUid = process.env.APPROVED_CALLER_RECONCILIATION_EXECUTION_ID?.trim() || "";
if (adapterPrincipalId !== APPROVED_CALLER_RECONCILIATION_ADAPTER_PRINCIPAL) {
  throw new Error("APPROVED_CALLER_ADAPTER_PRINCIPAL_INVALID");
}
if (adapterRuntimeIdentity !== APPROVED_CALLER_RECONCILIATION_ADAPTER_RUNTIME_IDENTITY) {
  throw new Error("APPROVED_CALLER_ADAPTER_RUNTIME_INVALID");
}
if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,190}$/u.test(podUid)) {
  throw new Error("APPROVED_CALLER_EXECUTION_ID_INVALID");
}

const claimSchema = trustedExecutorClaimSchema(approvedCallerReconciliationTaskSchema);
const bundleVerificationSchema = z.object({
  ok: z.literal(true),
  verification: z.object({
    state: z.literal("VERIFIED"),
    candidateDigest: z.string(),
    payloadDigest: z.string(),
    approvalPayloadDigest: z.string(),
    contractDigestsDigest: z.string(),
    runtimeAssetDigestsDigest: z.string(),
    evidenceDigest: z.string(),
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/u),
    workflowExecutionSha: z.string().regex(/^[0-9a-f]{40}$/u),
    keyId: z.string(),
    policyRevision: z.string(),
  }).strict(),
}).strict();

const workerRuntimeBindingDigest = jsonDigest({
  schemaVersion: 1,
  principal: APPROVED_CALLER_RECONCILIATION_EXECUTOR_PRINCIPAL,
  adapterPrincipalId,
  adapterRuntimeIdentity,
  workload: "approved-caller-reconciliation-executor",
});

function requestId(parts: Record<string, unknown>): string {
  return `${REQUEST_PREFIX}:${jsonDigest({ podUid, ...parts } as never)}`;
}

/** 승인 서명 검증은 중앙만 할 수 있다. 계약이 요구하는 envelope을 중앙에서 받아 그대로 넘긴다. */
function bundleVerifier(call: TrustedExecutorCall, sessionId: string) {
  return async (digests: {
    candidateDigest: string;
    payloadDigest: string;
    approvalPayloadDigest: string;
    contractDigestsDigest: string;
    runtimeAssetDigestsDigest: string;
    evidenceDigest: string;
  }): Promise<ApprovedBundleVerification> => bundleVerificationSchema.parse(await call({
    operation: "BUNDLE_VERIFY",
    sessionId,
    ...digests,
  }, requestId({ sessionId, operation: "bundle-verify", ...digests }))).verification;
}

async function runWithSecrets(input: {
  bearer: string;
  attestationKey: KeyObject;
  backofficeFetch: typeof globalThis.fetch;
  githubFetch: typeof globalThis.fetch;
}) {
  const call = createTrustedExecutorCall({
    route: ROUTE,
    backofficeOrigin,
    adapterPrincipalId,
    adapterRuntimeIdentity,
    bearer: input.bearer,
    attestationKey: input.attestationKey,
    fetchImpl: input.backofficeFetch,
    responseTooLargeCode: "APPROVED_CALLER_BACKOFFICE_RESPONSE_TOO_LARGE",
  });
  const claim = claimSchema.parse(
    await call({ operation: "CLAIM" }, requestId({ operation: "claim" })),
  ).claim;
  if (!claim) {
    console.log("[approved-caller-reconciliation-executor] no claim");
    return;
  }
  const heartbeat = startTrustedExecutorHeartbeat({
    call,
    requestPrefix: REQUEST_PREFIX,
    podUid,
    sessionId: claim.sessionId,
    generation: claim.generation,
  });
  const heartbeatTimer = await heartbeat.start();
  const guardedCall = heartbeat.guard(call);
  let executionId: string | null = null;
  const controlPlane = trustedExecutorControlPlane({
    call: guardedCall,
    captureExecutionId: (value) => { executionId = value; },
  });
  try {
    const result = await runMutation({
      claim,
      call: guardedCall,
      controlPlane,
      githubFetch: input.githubFetch,
      onRecoveryExecutionId: (value) => { executionId = value; },
    });
    clearInterval(heartbeatTimer);
    await heartbeat.settled();
    const settlementStatus = claim.resumeMode === "READBACK_FIRST"
      && result.status === "RESULT_UNKNOWN"
      && "safeToResume" in result
      && result.safeToResume
      ? "PARTIAL_VERIFIED" as const
      : result.status;
    await settleTrustedExecutorRun({
      call,
      requestPrefix: REQUEST_PREFIX,
      podUid,
      sessionId: claim.sessionId,
      mode: claim.resumeMode,
      status: settlementStatus,
      executionId: result.executionId,
      pullRequestNumber: result.pullRequestNumber,
      pullRequestUrl: result.pullRequestUrl,
    });
    console.log(`[approved-caller-reconciliation-executor] settled status=${settlementStatus}`);
  } catch (error) {
    clearInterval(heartbeatTimer);
    await heartbeat.settled().catch(() => undefined);
    const code = publicExecutorError(error, FAILED);
    await settleTrustedExecutorRun({
      call,
      requestPrefix: REQUEST_PREFIX,
      podUid,
      sessionId: claim.sessionId,
      mode: claim.resumeMode,
      status: executionId ? "RESULT_UNKNOWN" : "FAILED",
      executionId,
      errorCode: code,
    });
    throw new Error(code);
  }
}

type ExecutorClaim = NonNullable<z.infer<typeof claimSchema>["claim"]>;

async function runMutation(input: {
  claim: ExecutorClaim;
  call: TrustedExecutorCall;
  controlPlane: ReturnType<typeof trustedExecutorControlPlane>;
  githubFetch: typeof globalThis.fetch;
  onRecoveryExecutionId: (executionId: string) => void;
}) {
  const task = input.claim.task;
  if (input.claim.resumeMode === "READBACK_FIRST") {
    const recovery = await input.controlPlane.recover({
      requestId: requestId({ runId: input.claim.runId, operation: "recovery" }),
      body: {
        sessionId: input.claim.sessionId,
        workerPrincipalId: APPROVED_CALLER_RECONCILIATION_EXECUTOR_PRINCIPAL,
        workerRuntimeBindingDigest,
      },
    });
    input.onRecoveryExecutionId(recovery.executionId);
    return withGithubReadyPrInstallation({
      installationId: task.github.installationId,
      repositoryId: task.repository.id,
      repositoryFullName: task.repository.fullName,
      capability: "github.approved-caller-reconciliation.ready-pr",
      requestFetch: input.githubFetch,
      execute: (github) => recoverGithubReadyPr({
        operationId: input.claim.sessionId,
        sessionId: input.claim.sessionId,
        workerPrincipalId: APPROVED_CALLER_RECONCILIATION_EXECUTOR_PRINCIPAL,
        workerRuntimeBindingDigest,
        recovery,
        github,
        controlPlane: input.controlPlane,
      }),
    });
  }

  // 계약 호출에 대상 저장소의 exact source 체크아웃이 필요하다. installation token은
  // 체크아웃과 mutation 모두 같은 최소 권한 발급을 쓰고 콜백 밖으로 나가지 않는다.
  const contract = await loadWorkflowBundleV5Contract();
  const scoped = await getFleetScopedGithubTokenIssuer({ requestFetch: input.githubFetch });
  if (scoped.installationId !== task.github.installationId) {
    throw new Error("APPROVED_CALLER_INSTALLATION_ID_MISMATCH");
  }
  const prepared = await withFleetScopedGithubToken({
    issuer: scoped.issuer,
    installationId: task.github.installationId,
    capability: "github.approved-caller-reconciliation.ready-pr",
    repositoryId: task.repository.id,
    repositoryFullName: task.repository.fullName,
    execute: (token: string) => withTargetRepositoryCheckout({
      repoFullName: task.repository.fullName,
      sourceSha: task.repository.sourceSha,
      token,
      proxy: {
        origin: process.env.SEORI_EGRESS_PROXY_ORIGIN?.trim() || "",
        caPath: `${FIXED_ROOT}/egress/ca.pem`,
        certPath: `${FIXED_ROOT}/egress/tls.crt`,
        keyPath: `${FIXED_ROOT}/egress/tls.key`,
      },
      execute: (repoRoot) => generateApprovedCallerMutation({
        task,
        repoRoot,
        contract,
        verifyBundle: bundleVerifier(input.call, input.claim.sessionId),
      }),
    }),
  });
  return withGithubReadyPrInstallation({
    installationId: task.github.installationId,
    repositoryId: task.repository.id,
    repositoryFullName: task.repository.fullName,
    capability: "github.approved-caller-reconciliation.ready-pr",
    requestFetch: input.githubFetch,
    execute: (github) => executePreparedGithubReadyPr({
      operationId: input.claim.sessionId,
      workerPrincipalId: APPROVED_CALLER_RECONCILIATION_EXECUTOR_PRINCIPAL,
      workerRuntimeBindingDigest,
      prepared: {
        command: approvedCallerReconciliationCommand(
          task,
          input.claim.sessionId,
        ) as GithubReadyPrCommand,
        files: prepared.files,
        mutationIntentDigest: prepared.mutationIntentDigest,
      },
      github,
      controlPlane: input.controlPlane,
    }),
  });
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
  if (attestationKey.asymmetricKeyType !== "ed25519") {
    throw new Error("APPROVED_CALLER_ATTESTATION_KEY_INVALID");
  }
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
  console.error(
    `[approved-caller-reconciliation-executor] 종료 code=${publicExecutorError(error, FAILED)}`,
  );
  process.exitCode = 1;
});
