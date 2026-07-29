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

/** repoFullName 이 Xcode Cloud(iOS) 대상 allowlist 에 있는지. */
export function isXcodeCloudRepo(repoFullName: string): boolean {
  return env
    .optional("XCODE_CLOUD_APP_STORE_REPOS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(repoFullName);
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
  isEnabled: boolean;
  actions: unknown;
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

/**
 * 교차 앱 workflow가 같은 제품에 남아 있어도 요청 repo와 일치하는 App Store
 * Archive만 고른다. 0개나 2개 이상이면 임의 실행하지 않고 fail closed한다.
 */
export function selectWorkflowForRepository(
  candidates: WorkflowCandidate[],
  repoFullName: string,
): string {
  const matched = candidates.filter(
    (candidate) =>
      candidate.repoFullName === repoFullName &&
      candidate.isEnabled &&
      isAppStoreArchive(candidate.actions),
  );
  if (matched.length !== 1) {
    const names = matched.map((candidate) => candidate.name).join(", ") || "없음";
    throw new Error(
      `Xcode Cloud workflow 선택 실패(repo=${repoFullName}, 일치=${matched.length}, 후보=${names})`,
    );
  }
  return matched[0].id;
}

/** 제품의 workflow 중 요청 repository와 일치하는 활성 App Store Archive 선택. */
async function pickWorkflowId(productId: string, repoFullName: string): Promise<string> {
  const doc = await asc(`/v1/ciProducts/${productId}/workflows?limit=200`);
  const workflows = asArray(doc.data);
  const candidates = await Promise.all(
    workflows.map(async (workflow): Promise<WorkflowCandidate> => {
      let workflowRepo: string | null = null;
      try {
        const repoDoc = await asc(
          `/v1/ciWorkflows/${encodeURIComponent(workflow.id)}/repository`,
        );
        const repo = asArray(repoDoc.data)[0];
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
        isEnabled: workflow.attributes?.isEnabled === true,
        actions: workflow.attributes?.actions,
      };
    }),
  );
  return selectWorkflowForRepository(candidates, repoFullName);
}

/** 태그 이름 → 제품의 primary repository 상 git reference id. */
async function resolveTagRefId(productId: string, tag: string): Promise<string> {
  const repos = await asc(`/v1/ciProducts/${productId}/primaryRepositories?limit=10`);
  const repoId = asArray(repos.data)[0]?.id;
  if (!repoId) throw new Error("Xcode Cloud primary repository 없음");

  const refs = await asc(`/v1/scmRepositories/${repoId}/gitReferences?limit=200`);
  const ref = asArray(refs.data).find(
    (r) => r.attributes?.kind === "TAG" && r.attributes?.name === tag,
  );
  if (!ref) {
    throw new Error(`태그 ref 가 Xcode Cloud 에 아직 동기화되지 않음: ${tag}`);
  }
  return ref.id;
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
  const [workflowId, refId] = await Promise.all([
    pickWorkflowId(productId, opts.repoFullName),
    resolveTagRefId(productId, opts.tag),
  ]);

  const doc = await asc("/v1/ciBuildRuns", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "ciBuildRuns",
        relationships: {
          workflow: { data: { type: "ciWorkflows", id: workflowId } },
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
