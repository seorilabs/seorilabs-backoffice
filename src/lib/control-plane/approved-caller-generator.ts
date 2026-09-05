import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ApprovedCallerReconciliationTask } from "@/lib/control-plane/approved-caller-reconciliation-contract";
import { githubReadyPrMutationIntentDigest } from "@/lib/control-plane/github-ready-pr-adapter";
import { contractCanonicalJson, jsonDigest, type JsonValue } from "@/lib/control-plane/json";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const MAX_GIT_BUFFER = 8 * 1024 * 1024;

export interface ApprovedBundleVerification {
  state: string;
  candidateDigest: string;
  payloadDigest: string;
  approvalPayloadDigest: string;
  contractDigestsDigest: string;
  runtimeAssetDigestsDigest: string;
  evidenceDigest: string;
  sourceSha: string;
  workflowExecutionSha: string;
  keyId: string;
  policyRevision: string;
}

interface WorkflowBundleV5Contract {
  loadApprovedWorkflowBundleV5(
    bundle: unknown,
    options: {
      trustedApprovalVerifier: (input: {
        candidateDigest: string;
        payloadDigest: string;
        contractDigests: Record<string, unknown>;
        runtimeAssetDigests: Record<string, unknown>;
        evidence: unknown[];
        approvalPayloadDigest: string;
      }) => Promise<Record<string, unknown>>;
    },
  ): Promise<object>;
  loadResolvedWorkflowBindingV5(
    repositoryContext: { repositoryId: string; fullName: string; sourceSha: string },
    options: {
      trustedResolvedManifestReadback: (
        context: { repositoryId: string; fullName: string; sourceSha: string },
      ) => Promise<unknown>;
      repoRoot: string;
    },
  ): Promise<object>;
  generateStaticCallerV5(options: {
    approvedBundleBinding: object;
    resolvedBinding: object;
  }): string;
  validateStaticCallerV5(
    caller: string,
    options: { approvedBundleBinding: object; resolvedBinding: object },
  ): { ok: boolean; diagnostics: readonly string[] };
}

/**
 * 중앙 계약 구현은 top-level await ESM이라 Next 서버 번들에 들어가지 못한다. 실행기는
 * 런타임 dynamic import로만 읽는다. 이 경로를 정적 import로 바꾸면 Backoffice 빌드가 깨진다.
 */
export async function loadWorkflowBundleV5Contract(): Promise<WorkflowBundleV5Contract> {
  return await import(
    "seorilabs-org-contracts/repo-contract/workflow-bundle-v5"
  ) as unknown as WorkflowBundleV5Contract;
}

/**
 * 계약은 대상 저장소의 exact source 체크아웃을 요구한다(HEAD == sourceSha, 선언 경로 존재).
 * 얕은 fetch로 정확히 그 커밋만 가져오고, 다른 ref는 만들지 않는다.
 */
export interface GitEgressProxy {
  /** https://host:port 형태의 mTLS CONNECT proxy origin이다. */
  origin: string;
  caPath: string;
  certPath: string;
  keyPath: string;
}

export async function withTargetRepositoryCheckout<Result>(input: {
  repoFullName: string;
  sourceSha: string;
  token: string;
  proxy?: GitEgressProxy;
  gitEnv?: NodeJS.ProcessEnv;
  execute: (repoRoot: string) => Promise<Result>;
}): Promise<Result> {
  const repoRoot = await mkdtemp(join(tmpdir(), "approved-caller-"));
  // git은 PATH가 필요하다. 그 위에 실행기 전용 값을 덮어써 프롬프트와 시스템 config를 막는다.
  const env = {
    ...process.env,
    ...input.gitEnv,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: repoRoot,
  };
  const git = (args: string[]) => run("git", ["-C", repoRoot, ...args], {
    env,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_BUFFER,
  });
  try {
    await run("git", ["init", "--quiet", repoRoot], { env, timeout: GIT_TIMEOUT_MS });
    // 토큰은 remote URL로 남기지 않는다. 헤더로만 전달하고 파일에 쓰지 않는다.
    const authorization = `Authorization: Basic ${Buffer.from(`x-access-token:${input.token}`, "utf8").toString("base64")}`;
    // 파드는 egress proxy 밖으로 나가지 못한다. git도 같은 mTLS CONNECT 경계를 쓴다.
    const proxyConfig = input.proxy
      ? [
          "-c", `http.proxy=${input.proxy.origin}`,
          "-c", `http.proxySSLCAInfo=${input.proxy.caPath}`,
          "-c", `http.proxySSLCert=${input.proxy.certPath}`,
          "-c", `http.proxySSLKey=${input.proxy.keyPath}`,
        ]
      : [];
    await git([
      ...proxyConfig,
      "-c", `http.https://github.com/.extraheader=${authorization}`,
      "fetch", "--quiet", "--depth", "1", "--no-tags",
      `https://github.com/${input.repoFullName}.git`, input.sourceSha,
    ]);
    await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
    if (head !== input.sourceSha) throw new Error("APPROVED_CALLER_CHECKOUT_SOURCE_MISMATCH");
    return await input.execute(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

/**
 * caller 본문과 mutation 의도를 중앙 계약에서만 만든다. Backoffice는 이 규칙을 복제하지
 * 않으므로, 여기서 생성한 결과가 곧 authorize가 고정할 intent가 된다.
 */
export async function generateApprovedCallerMutation(input: {
  task: ApprovedCallerReconciliationTask;
  repoRoot: string;
  contract: WorkflowBundleV5Contract;
  verifyBundle: (digests: {
    candidateDigest: string;
    payloadDigest: string;
    approvalPayloadDigest: string;
    contractDigestsDigest: string;
    runtimeAssetDigestsDigest: string;
    evidenceDigest: string;
  }) => Promise<ApprovedBundleVerification>;
}): Promise<{
  files: Array<{ path: string; content: string; mode: "100644"; contentSha256: string }>;
  mutationIntentDigest: string;
}> {
  const { task, contract } = input;
  const approvedBundleBinding = await contract.loadApprovedWorkflowBundleV5(task.approvedBundle.bundle, {
    trustedApprovalVerifier: async (verifierInput) => input.verifyBundle({
      candidateDigest: verifierInput.candidateDigest,
      payloadDigest: verifierInput.payloadDigest,
      approvalPayloadDigest: verifierInput.approvalPayloadDigest,
      contractDigestsDigest: digestOf(verifierInput.contractDigests),
      runtimeAssetDigestsDigest: digestOf(verifierInput.runtimeAssetDigests),
      evidenceDigest: digestOf(verifierInput.evidence),
    }) as unknown as Promise<Record<string, unknown>>,
  });
  const resolvedBinding = await contract.loadResolvedWorkflowBindingV5({
    repositoryId: task.repository.id,
    fullName: task.repository.fullName,
    sourceSha: task.repository.sourceSha,
  }, {
    trustedResolvedManifestReadback: async (context) => {
      if (
        context.repositoryId !== task.repository.id
        || context.fullName !== task.repository.fullName
        || context.sourceSha !== task.repository.sourceSha
      ) throw new Error("APPROVED_CALLER_MANIFEST_CONTEXT_MISMATCH");
      return task.resolvedManifest;
    },
    repoRoot: input.repoRoot,
  });
  const caller = contract.generateStaticCallerV5({ approvedBundleBinding, resolvedBinding });
  const validation = contract.validateStaticCallerV5(caller, { approvedBundleBinding, resolvedBinding });
  if (!validation.ok) {
    throw new Error(validation.diagnostics[0] ?? "APPROVED_CALLER_GENERATED_INVALID");
  }
  const files = [{
    path: task.caller.path,
    content: caller,
    mode: "100644" as const,
    contentSha256: jsonDigest(caller),
  }];
  return {
    files,
    mutationIntentDigest: githubReadyPrMutationIntentDigest({
      repoId: task.repository.id,
      repoFullName: task.repository.fullName,
      issueNumber: null,
      sourceSha: task.repository.sourceSha,
      title: task.mutation.title,
      body: task.mutation.body,
      commitMessage: task.mutation.commitMessage,
    }, files),
  };
}

/**
 * 계약이 쓰는 code unit 정렬 canonical JSON digest다. 중앙이 같은 값을 다시 계산해
 * 대조하므로 정규화가 갈리면 즉시 fail-closed된다.
 */
function digestOf(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(contractCanonicalJson(value as JsonValue))
    .digest("hex")}`;
}
