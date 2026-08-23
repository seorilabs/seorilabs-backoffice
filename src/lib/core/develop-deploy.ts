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
  buildDevelopMarketInputs,
  DEVELOP_DEPLOY_TARGET_KO,
  developDeployTargetsFor,
  nextDevelopCandidateTag,
  parseDevelopCandidateTag,
  resolveDevelopDeployDispatchRef,
  resolveDevelopCandidateBase,
  type DevelopDeployTarget,
} from "@/lib/core/develop-candidate";
import { isXcodeCloudRepo } from "@/lib/xcode-cloud/dispatch";
import { dispatchXcodeCloudRelease } from "@/lib/xcode-cloud/release";

export const DEVELOP_BRANCH = "develop";
export const DEVELOP_AIT_WORKFLOW = "deploy-apps-in-toss.yml";
export const DEVELOP_PLAY_WORKFLOW = "deploy-google-play.yml";

const GITHUB_WORKFLOW: Partial<Record<DevelopDeployTarget, string>> = {
  AIT: DEVELOP_AIT_WORKFLOW,
  PLAY: DEVELOP_PLAY_WORKFLOW,
};

type JsonObject = Record<string, unknown>;

interface GithubDeployPlan {
  target: "AIT" | "PLAY";
  workflowFile: string;
  dispatchRef: string;
  inputs: Record<string, string>;
}

export interface DevelopDeployDestination {
  target: DevelopDeployTarget;
  label: string;
  url?: string;
  xcodeCloudBuild?: number | null;
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function sameTargets(
  left: readonly DevelopDeployTarget[],
  right: readonly DevelopDeployTarget[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function assertDevelopTargets(
  repoFullName: string,
  marketTargets: unknown,
  iosBundle?: string | null,
): DevelopDeployTarget[] {
  const targets = developDeployTargetsFor(marketTargets);
  const requiredTargets: DevelopDeployTarget[] = ["AIT", "PLAY", "TESTFLIGHT"];
  const missing = requiredTargets.filter((target) => !targets.includes(target));
  if (missing.length > 0) {
    throw new Error(
      `${repoFullName}의 develop 후보 배포 대상이 부족합니다: ${missing
        .map((target) => DEVELOP_DEPLOY_TARGET_KO[target])
        .join(", ")}`,
    );
  }
  if (targets.includes("TESTFLIGHT")) {
    if (!isXcodeCloudRepo(repoFullName)) {
      throw new Error(
        `${repoFullName}은 Xcode Cloud allowlist에 없어 TestFlight 후보를 안전하게 실행할 수 없습니다.`,
      );
    }
    if (!iosBundle) {
      throw new Error(`iosBundle 미설정: ${repoFullName} — TestFlight 후보 실행 불가`);
    }
  }
  return targets;
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

async function prepareGithubDeployPlans(opts: {
  repoFullName: string;
  defaultBranch: string;
  targets: readonly DevelopDeployTarget[];
  tag: string;
  sha: string;
}): Promise<GithubDeployPlan[]> {
  if (!parseDevelopCandidateTag(opts.tag)) {
    throw new Error(`develop 후보 태그 형식이 아닙니다: ${opts.tag}`);
  }

  return Promise.all(
    opts.targets
      .filter((target): target is "AIT" | "PLAY" => target !== "TESTFLIGHT")
      .map(async (target) => {
        const workflowFile = GITHUB_WORKFLOW[target];
        if (!workflowFile) throw new Error(`develop 배포 workflow가 없습니다: ${target}`);
        // workflow_dispatch API 진입점은 기본 브랜치에, 실제 실행 정의는 후보가 가리킬
        // develop에 모두 있어야 한다. 입력 검증도 실제 실행 ref와 같은 develop 정의를 쓴다.
        const defaultWorkflow = await getWorkflowDispatchContract(
          opts.repoFullName,
          workflowFile,
          opts.defaultBranch,
        );
        if (!defaultWorkflow.dispatchable) {
          throw new Error(
            `${opts.defaultBranch}의 ${workflowFile}에 workflow_dispatch가 없습니다.`,
          );
        }
        const workflow = opts.defaultBranch === DEVELOP_BRANCH
          ? defaultWorkflow
          : await getWorkflowDispatchContract(
            opts.repoFullName,
            workflowFile,
            DEVELOP_BRANCH,
          );
        if (!workflow.dispatchable) {
          throw new Error(
            `${DEVELOP_BRANCH}의 ${workflowFile}에 workflow_dispatch가 없습니다.`,
          );
        }
        const dispatchRef = resolveDevelopDeployDispatchRef(
          opts.defaultBranch,
          workflow.inputNames,
          opts.tag,
        );
        const inputs = buildDevelopMarketInputs(
          target,
          workflow.inputNames,
          opts.tag,
          opts.sha,
          { repoFullName: opts.repoFullName, workflowFile },
        );
        return { target, workflowFile, dispatchRef, inputs };
      }),
  );
}

export interface DevelopDeployPreview {
  branch: typeof DEVELOP_BRANCH;
  sha: string;
  tag: string;
  targets: DevelopDeployTarget[];
  destinations: DevelopDeployDestination[];
}

/** 외부 write 전 develop HEAD와 모든 테스트 배포 caller를 검증한다. */
export async function previewDevelopDeploy(
  repoFullName: string,
  options: { marketTargets: unknown; iosBundle?: string | null },
): Promise<DevelopDeployPreview> {
  const targets = assertDevelopTargets(
    repoFullName,
    options.marketTargets,
    options.iosBundle,
  );
  const defaultBranch = await getRepoDefaultBranch(repoFullName);
  const [sha, context] = await Promise.all([
    resolveRefSha(repoFullName, DEVELOP_BRANCH),
    candidateBaseContext(repoFullName),
  ]);
  const tag = nextDevelopCandidateTag(
    context.baseTag,
    context.tags.map((item) => item.name),
  );
  const plans = await prepareGithubDeployPlans({
    repoFullName,
    defaultBranch,
    targets,
    tag,
    sha,
  });
  return {
    branch: DEVELOP_BRANCH,
    sha,
    tag,
    targets,
    destinations: [
      ...plans.map((plan) => ({
        target: plan.target,
        label: DEVELOP_DEPLOY_TARGET_KO[plan.target],
        url: `https://github.com/${repoFullName}/actions/workflows/${plan.workflowFile}`,
      })),
      ...(targets.includes("TESTFLIGHT")
        ? [{ target: "TESTFLIGHT" as const, label: DEVELOP_DEPLOY_TARGET_KO.TESTFLIGHT }]
        : []),
    ],
  };
}

/** 확인된 develop SHA에 후보 태그를 붙인 뒤 등록된 모든 내부 테스트 채널을 실행한다. */
export async function createAndDispatchDevelopDeploy(opts: {
  repoFullName: string;
  expectedSha: string;
  expectedTargets: readonly DevelopDeployTarget[];
  marketTargets: unknown;
  iosBundle?: string | null;
  tag: string;
  actorLabel?: string;
}): Promise<{
  tag: string;
  sha: string;
  created: boolean;
  destinations: DevelopDeployDestination[];
}> {
  if (!parseDevelopCandidateTag(opts.tag)) {
    throw new Error(`develop 후보 태그 형식이 아닙니다: ${opts.tag}`);
  }

  const currentTargets = assertDevelopTargets(
    opts.repoFullName,
    opts.marketTargets,
    opts.iosBundle,
  );
  if (!sameTargets(currentTargets, opts.expectedTargets)) {
    throw new Error("확인 후 테스트 배포 대상이 변경됐습니다. 다시 요청해 확인하세요.");
  }

  const currentSha = await resolveRefSha(opts.repoFullName, DEVELOP_BRANCH);
  if (currentSha !== opts.expectedSha) {
    throw new Error(
      `develop HEAD가 ${opts.expectedSha.slice(0, 7)}에서 ${currentSha.slice(0, 7)}(으)로 변경됐습니다. 다시 요청해 확인하세요.`,
    );
  }

  const defaultBranch = await getRepoDefaultBranch(opts.repoFullName);
  // 태그를 만들기 전에 GitHub caller의 dispatch/input 계약을 모두 검증한다.
  const plans = await prepareGithubDeployPlans({
    repoFullName: opts.repoFullName,
    defaultBranch,
    targets: currentTargets,
    tag: opts.tag,
    sha: opts.expectedSha,
  });

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
        targets: currentTargets,
        created,
      } as object,
    },
  }).catch(() => {});

  const destinations: DevelopDeployDestination[] = [];
  const failures: string[] = [];
  for (const plan of plans) {
    try {
      await dispatchWorkflow({
        repoFullName: opts.repoFullName,
        workflowFile: plan.workflowFile,
        ref: plan.dispatchRef,
        inputs: plan.inputs,
      });
      destinations.push({
        target: plan.target,
        label: DEVELOP_DEPLOY_TARGET_KO[plan.target],
        url: `https://github.com/${opts.repoFullName}/actions/workflows/${plan.workflowFile}`,
      });
      await recordDevelopDispatch(opts, {
        target: plan.target,
        workflowFile: plan.workflowFile,
        dispatchRef: plan.dispatchRef,
      });
    } catch (error) {
      failures.push(
        `${DEVELOP_DEPLOY_TARGET_KO[plan.target]}: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
      );
    }
  }

  if (currentTargets.includes("TESTFLIGHT")) {
    try {
      const run = await dispatchXcodeCloudRelease({
        repoFullName: opts.repoFullName,
        tag: opts.tag,
        actorLabel: opts.actorLabel,
      });
      destinations.push({
        target: "TESTFLIGHT",
        label: DEVELOP_DEPLOY_TARGET_KO.TESTFLIGHT,
        xcodeCloudBuild: run.buildNumber,
      });
      await recordDevelopDispatch(opts, {
        target: "TESTFLIGHT",
        xcodeCloudBuild: run.buildNumber,
        externalRunId: run.buildRunId,
      });
    } catch (error) {
      failures.push(
        `${DEVELOP_DEPLOY_TARGET_KO.TESTFLIGHT}: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
      );
    }
  }

  if (failures.length > 0) {
    const succeeded = destinations.map((item) => item.label).join(", ") || "없음";
    throw new Error(
      `develop 후보 ${opts.tag} 일부 트리거 실패 (성공: ${succeeded}; 실패: ${failures.join(" / ")})`,
    );
  }

  return { tag: opts.tag, sha: opts.expectedSha, created, destinations };
}

async function recordDevelopDispatch(
  opts: {
    repoFullName: string;
    tag: string;
    expectedSha: string;
    actorLabel?: string;
  },
  payload: Record<string, unknown>,
): Promise<void> {
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
        ...payload,
      } as object,
    },
  }).catch(() => {});
}
