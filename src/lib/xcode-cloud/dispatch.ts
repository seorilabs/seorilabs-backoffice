// Xcode Cloud(App Store Connect API) 배포 트리거.
//
// iOS 빌드/업로드를 GitHub Actions(macOS 쿼타) 대신 Xcode Cloud 로 이관한 앱은,
// 릴리즈 시 GH workflow_dispatch 가 아니라 여기서 ASC API 로 명시적으로 빌드를
// 트리거한다(태그 ref 대상). org 릴리즈 모델(태그 자동배포가 아니라 Backoffice
// 명시 dispatch)과 동일하게 동작한다.
//
// ASC JWT/fetch/JSON:API 헬퍼는 app-store/asc-client.ts 공용.
//   XCODE_CLOUD_APP_STORE_REPOS (Xcode Cloud 로 iOS 를 빌드하는 repoFullName CSV)

import { env } from "@/lib/env";
import { asc, asArray } from "@/lib/app-store/asc-client";
import type { DeployTarget } from "@/lib/core/deploy-targets";

const TAG_REF_RETRY_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000] as const;

/** repoFullName 이 Xcode Cloud(iOS) 대상 allowlist 에 있는지. */
export function isXcodeCloudRepo(repoFullName: string): boolean {
  return env
    .optional("XCODE_CLOUD_APP_STORE_REPOS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(repoFullName);
}

/** App Store가 포함된 배포 대상에서 ASC Xcode Cloud 경로를 선택할지 판정한다. */
export function shouldUseXcodeCloudForTarget(
  repoFullName: string,
  target: DeployTarget,
): boolean {
  return (
    isXcodeCloudRepo(repoFullName) &&
    (target === "APPSTORE" || target === "ALL")
  );
}

/** bundleId 로 Xcode Cloud 제품(ciProduct) 찾기. */
async function findProductId(bundleId: string): Promise<string> {
  const doc = await asc("/v1/ciProducts?include=app&limit=200");
  const apps = doc.included ?? [];
  const product = asArray(doc.data).find((p) => {
    const appId = p.relationships?.app?.data?.id;
    const app = apps.find((a) => a.id === appId);
    return app?.attributes?.bundleId === bundleId;
  });
  if (!product) throw new Error(`Xcode Cloud 제품 없음(bundleId=${bundleId})`);
  return product.id;
}

export interface WorkflowCandidate {
  id: string;
  name: string;
  repoFullName: string | null;
  repositoryId: string | null;
  isEnabled: boolean;
  actions: unknown;
  manualTagStartCondition: unknown;
}

export interface WorkflowSelection {
  workflowId: string;
  repositoryId: string;
}

export interface GitReferenceCandidate {
  id: string;
  attributes?: Record<string, unknown>;
}

/** ASC git reference 목록에서 정확한 태그 ref id를 찾는다. */
export function findTagRefId(
  refs: GitReferenceCandidate[],
  tag: string,
): string | null {
  const ref = refs.find(
    (candidate) =>
      candidate.attributes?.kind === "TAG" && candidate.attributes?.name === tag,
  );
  return ref?.id ?? null;
}

/**
 * GitHub 태그 생성과 Xcode Cloud SCM 인덱싱 사이의 짧은 지연을 흡수한다.
 * POST 빌드 호출 전 조회만 반복하므로 중복 Xcode Cloud 빌드를 만들지 않는다.
 */
export async function waitForTagRefId(
  tag: string,
  loadRefs: () => Promise<GitReferenceCandidate[]>,
  options: {
    delaysMs?: readonly number[];
    sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<string> {
  const delaysMs = options.delaysMs ?? TAG_REF_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  for (const delayMs of delaysMs) {
    if (delayMs > 0) await sleep(delayMs);
    const refId = findTagRefId(await loadRefs(), tag);
    if (refId) return refId;
  }

  const waitedMs = delaysMs.reduce((sum, delayMs) => sum + delayMs, 0);
  throw new Error(
    `태그 ref 가 Xcode Cloud 에 ${Math.ceil(waitedMs / 1_000)}초 동안 동기화되지 않음: ${tag}. ` +
      "workflow의 Manual Tag 시작 조건과 SCM 연결 상태를 확인하세요.",
  );
}

function isAppStoreArchive(actions: unknown): boolean {
  if (!Array.isArray(actions)) return false;
  return actions.some((action) => {
    if (!action || typeof action !== "object") return false;
    const value = action as Record<string, unknown>;
    return (
      value.actionType === "ARCHIVE" &&
      value.platform === "IOS" &&
      value.buildDistributionAudience === "APP_STORE_ELIGIBLE"
    );
  });
}

/** Xcode Cloud의 수동 태그 조건은 glob이 아니라 대소문자 구분 exact/prefix 계약이다. */
export function matchesManualTagStartCondition(
  condition: unknown,
  tag: string,
): boolean {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    return false;
  }
  const source = (condition as Record<string, unknown>).source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  const value = source as Record<string, unknown>;
  if (value.isAllMatch === true) return true;
  if (value.isAllMatch !== false || !Array.isArray(value.patterns)) return false;
  return value.patterns.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const pattern = item as Record<string, unknown>;
    if (typeof pattern.pattern !== "string" || typeof pattern.isPrefix !== "boolean") {
      return false;
    }
    return pattern.isPrefix ? tag.startsWith(pattern.pattern) : tag === pattern.pattern;
  });
}

/**
 * 교차 앱 workflow가 같은 제품에 남아 있어도 요청 repo와 일치하는 App Store
 * Archive만 고른다. 0개나 2개 이상이면 임의 실행하지 않고 fail closed한다.
 */
export function selectWorkflowForRepository(
  candidates: WorkflowCandidate[],
  repoFullName: string,
  tag: string,
): WorkflowSelection {
  const matched = candidates.filter(
    (candidate) =>
      candidate.repoFullName === repoFullName &&
      candidate.isEnabled &&
      isAppStoreArchive(candidate.actions) &&
      matchesManualTagStartCondition(candidate.manualTagStartCondition, tag),
  );
  if (matched.length !== 1) {
    const names = matched.map((candidate) => candidate.name).join(", ") || "없음";
    throw new Error(
      `Xcode Cloud workflow 선택 실패(repo=${repoFullName}, tag=${tag}, 수동 태그 조건 일치=${matched.length}, 후보=${names})`,
    );
  }
  if (!matched[0].repositoryId) {
    throw new Error(
      `Xcode Cloud workflow repository ID 없음(repo=${repoFullName}, workflow=${matched[0].name})`,
    );
  }
  return {
    workflowId: matched[0].id,
    repositoryId: matched[0].repositoryId,
  };
}

/** 제품의 workflow 중 요청 repository와 일치하는 활성 App Store Archive 선택. */
async function pickWorkflow(
  productId: string,
  repoFullName: string,
  tag: string,
): Promise<WorkflowSelection> {
  const doc = await asc(
    `/v1/ciProducts/${productId}/workflows?limit=200&` +
      "fields[ciWorkflows]=name,isEnabled,actions,manualTagStartCondition",
  );
  const workflows = asArray(doc.data);
  const candidates = await Promise.all(
    workflows.map(async (workflow): Promise<WorkflowCandidate> => {
      let workflowRepo: string | null = null;
      let repositoryId: string | null = null;
      try {
        const repoDoc = await asc(
          `/v1/ciWorkflows/${encodeURIComponent(workflow.id)}/repository`,
        );
        const repo = asArray(repoDoc.data)[0];
        repositoryId = repo?.id ?? null;
        const owner = repo?.attributes?.ownerName;
        const name = repo?.attributes?.repositoryName;
        if (typeof owner === "string" && typeof name === "string") {
          workflowRepo = `${owner}/${name}`;
        }
      } catch {
        // 관계가 깨진 잔존 workflow는 후보에서 제외한다.
      }
      return {
        id: workflow.id,
        name:
          typeof workflow.attributes?.name === "string"
            ? workflow.attributes.name
            : workflow.id,
        repoFullName: workflowRepo,
        repositoryId,
        isEnabled: workflow.attributes?.isEnabled === true,
        actions: workflow.attributes?.actions,
        manualTagStartCondition: workflow.attributes?.manualTagStartCondition,
      };
    }),
  );
  return selectWorkflowForRepository(candidates, repoFullName, tag);
}

/** 외부 write 전에 제품·repo·수동 태그 시작 조건을 검증한다. */
export async function validateXcodeCloudDeploy(opts: {
  bundleId: string;
  repoFullName: string;
  tag: string;
}): Promise<void> {
  const productId = await findProductId(opts.bundleId);
  await pickWorkflow(productId, opts.repoFullName, opts.tag);
}

/** 태그 이름 → 선택한 workflow repository의 git reference id. */
async function resolveTagRefId(repositoryId: string, tag: string): Promise<string> {
  return waitForTagRefId(
    tag,
    async () => {
      const refs = await asc(
        `/v1/scmRepositories/${encodeURIComponent(repositoryId)}/gitReferences?limit=200`,
      );
      return asArray(refs.data);
    },
  );
}

/**
 * Xcode Cloud 빌드(archive → TestFlight)를 태그 대상으로 명시적 트리거.
 * 반환: 빌드런 id 와 번호.
 */
export async function triggerXcodeCloudDeploy(opts: {
  bundleId: string;
  repoFullName: string;
  tag: string;
}): Promise<{ buildRunId: string; buildNumber: number | null }> {
  const productId = await findProductId(opts.bundleId);
  const selection = await pickWorkflow(productId, opts.repoFullName, opts.tag);
  const refId = await resolveTagRefId(selection.repositoryId, opts.tag);

  const doc = await asc("/v1/ciBuildRuns", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "ciBuildRuns",
        relationships: {
          workflow: {
            data: { type: "ciWorkflows", id: selection.workflowId },
          },
          sourceBranchOrTag: { data: { type: "scmGitReferences", id: refId } },
        },
      },
    }),
  });
  const run = asArray(doc.data)[0];
  const number = run?.attributes?.number;
  return {
    buildRunId: run?.id ?? "",
    buildNumber: typeof number === "number" ? number : null,
  };
}
