import { prisma } from "@/lib/prisma";
import {
  getRepoJsonFile,
  getRepoDefaultBranch,
  getWorkflowDispatchContract,
} from "@/lib/github/read";
import { listRepositoryTags } from "@/lib/github/release";
import {
  createTag,
  dispatchWorkflow,
  resolveRefSha,
} from "@/lib/github/write";
import { marketVersionFloorFromConfigs } from "@/lib/core/market-version-floor";
import {
  buildDevelopDeployInputs,
  nextDevelopCandidateTag,
  parseDevelopCandidateTag,
  resolveDevelopDeployDispatchRef,
  resolveDevelopCandidateBase,
} from "@/lib/core/develop-candidate";

export const DEVELOP_BRANCH = "develop";
export const DEVELOP_AIT_WORKFLOW = "deploy-apps-in-toss.yml";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

async function candidateBaseContext(repoFullName: string) {
  const [tags, googlePlay, appStore, packageJson] = await Promise.all([
    listRepositoryTags(repoFullName),
    getRepoJsonFile(repoFullName, "play-store/google-play.config.json", DEVELOP_BRANCH),
    getRepoJsonFile(repoFullName, "app-store/app-store.config.json", DEVELOP_BRANCH),
    getRepoJsonFile(repoFullName, "package.json", DEVELOP_BRANCH),
  ]);
  const packageVersion = object(packageJson)?.version;
  const marketFloor = marketVersionFloorFromConfigs({ googlePlay, appStore });
  const baseTag = resolveDevelopCandidateBase({
    tags: tags.map((tag) => tag.name),
    marketFloor,
    packageVersion,
  });
  return { tags, baseTag };
}

export interface DevelopDeployPreview {
  branch: typeof DEVELOP_BRANCH;
  sha: string;
  tag: string;
  workflowFile: typeof DEVELOP_AIT_WORKFLOW;
  dispatchRef: string;
}

/** 외부 write 전 develop HEAD·후보 태그·dispatch 가능 여부를 고정한다. */
export async function previewDevelopDeploy(
  repoFullName: string,
): Promise<DevelopDeployPreview> {
  const defaultBranch = await getRepoDefaultBranch(repoFullName);
  const [sha, context, workflow] = await Promise.all([
    resolveRefSha(repoFullName, DEVELOP_BRANCH),
    candidateBaseContext(repoFullName),
    getWorkflowDispatchContract(repoFullName, DEVELOP_AIT_WORKFLOW, defaultBranch),
  ]);
  if (!workflow.dispatchable) {
    throw new Error(
      `${defaultBranch}의 ${DEVELOP_AIT_WORKFLOW}에 workflow_dispatch가 없습니다.`,
    );
  }
  const tag = nextDevelopCandidateTag(
    context.baseTag,
    context.tags.map((item) => item.name),
  );
  return {
    branch: DEVELOP_BRANCH,
    sha,
    tag,
    workflowFile: DEVELOP_AIT_WORKFLOW,
    dispatchRef: resolveDevelopDeployDispatchRef(
      defaultBranch,
      workflow.inputNames,
      tag,
    ),
  };
}

/** 확인된 develop SHA에 후보 태그를 붙인 뒤 그 태그의 AIT 빌드·배포 caller를 실행한다. */
export async function createAndDispatchDevelopDeploy(opts: {
  repoFullName: string;
  expectedSha: string;
  tag: string;
  actorLabel?: string;
}): Promise<{ tag: string; sha: string; created: boolean; workflowUrl: string }> {
  const parsed = parseDevelopCandidateTag(opts.tag);
  if (!parsed) throw new Error(`develop 후보 태그 형식이 아닙니다: ${opts.tag}`);

  const currentSha = await resolveRefSha(opts.repoFullName, DEVELOP_BRANCH);
  if (currentSha !== opts.expectedSha) {
    throw new Error(
      `develop HEAD가 ${opts.expectedSha.slice(0, 7)}에서 ${currentSha.slice(0, 7)}(으)로 변경됐습니다. 다시 요청해 확인하세요.`,
    );
  }

  const defaultBranch = await getRepoDefaultBranch(opts.repoFullName);
  const workflow = await getWorkflowDispatchContract(
    opts.repoFullName,
    DEVELOP_AIT_WORKFLOW,
    defaultBranch,
  );
  if (!workflow.dispatchable) {
    throw new Error(
      `${defaultBranch}의 ${DEVELOP_AIT_WORKFLOW}에 workflow_dispatch가 없습니다.`,
    );
  }

  const dispatchRef = resolveDevelopDeployDispatchRef(
    defaultBranch,
    workflow.inputNames,
    opts.tag,
  );

  const { created } = await createTag({
    repoFullName: opts.repoFullName,
    tag: opts.tag,
    sha: opts.expectedSha,
  });
  await prisma.auditLog.create({
    data: {
      actorLogin: opts.actorLabel ?? null,
      action: "develop.candidate.tag.create",
      entityType: "release-candidate",
      entityId: `${opts.repoFullName}@${opts.tag}`,
      payload: {
        branch: DEVELOP_BRANCH,
        tag: opts.tag,
        sha: opts.expectedSha,
        created,
      } as object,
    },
  }).catch(() => {});

  const inputs = buildDevelopDeployInputs(
    workflow.inputNames,
    opts.tag,
    opts.expectedSha,
  );
  await dispatchWorkflow({
    repoFullName: opts.repoFullName,
    workflowFile: DEVELOP_AIT_WORKFLOW,
    ref: dispatchRef,
    inputs,
  });

  await prisma.auditLog.create({
    data: {
      actorLogin: opts.actorLabel ?? null,
      action: "develop.deploy.dispatch",
      entityType: "release-candidate",
      entityId: `${opts.repoFullName}@${opts.tag}`,
      payload: {
        branch: DEVELOP_BRANCH,
        tag: opts.tag,
        sha: opts.expectedSha,
        workflowFile: DEVELOP_AIT_WORKFLOW,
        dispatchRef,
      } as object,
    },
  }).catch(() => {});

  return {
    tag: opts.tag,
    sha: opts.expectedSha,
    created,
    workflowUrl: `https://github.com/${opts.repoFullName}/actions/workflows/${DEVELOP_AIT_WORKFLOW}`,
  };
}
