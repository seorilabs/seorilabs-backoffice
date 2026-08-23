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
  assertSnapshotDefaultBranch,
  buildSnapshotMarketInputs,
  SNAPSHOT_BRANCH,
  SNAPSHOT_DEPLOY_TARGET_KO,
  snapshotDeployTargetsFor,
  nextSnapshotCandidateTag,
  parseSnapshotCandidateTag,
  resolveSnapshotDeployDispatchRef,
  resolveSnapshotCandidateBase,
  type SnapshotDeployTarget,
} from "@/lib/core/snapshot-candidate";
import { isXcodeCloudRepo } from "@/lib/xcode-cloud/dispatch";
import { dispatchXcodeCloudRelease } from "@/lib/xcode-cloud/release";

export const SNAPSHOT_AIT_WORKFLOW = "deploy-apps-in-toss.yml";
export const SNAPSHOT_PLAY_WORKFLOW = "deploy-google-play.yml";

const GITHUB_WORKFLOW: Partial<Record<SnapshotDeployTarget, string>> = {
  AIT: SNAPSHOT_AIT_WORKFLOW,
  PLAY: SNAPSHOT_PLAY_WORKFLOW,
};

type JsonObject = Record<string, unknown>;

interface GithubDeployPlan {
  target: "AIT" | "PLAY";
  workflowFile: string;
  dispatchRef: string;
  inputs: Record<string, string>;
}

export interface SnapshotDeployDestination {
  target: SnapshotDeployTarget;
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
  left: readonly SnapshotDeployTarget[],
  right: readonly SnapshotDeployTarget[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function assertSnapshotTargets(
  repoFullName: string,
  marketTargets: unknown,
  iosBundle?: string | null,
): SnapshotDeployTarget[] {
  const targets = snapshotDeployTargetsFor(marketTargets);
  const requiredTargets: SnapshotDeployTarget[] = ["AIT", "PLAY", "TESTFLIGHT"];
  const missing = requiredTargets.filter((target) => !targets.includes(target));
  if (missing.length > 0) {
    throw new Error(
      `${repoFullName}의 snapshot 후보 배포 대상이 부족합니다: ${missing
        .map((target) => SNAPSHOT_DEPLOY_TARGET_KO[target])
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
    getRepoJsonFile(repoFullName, "play-store/google-play.config.json", SNAPSHOT_BRANCH),
    getRepoJsonFile(repoFullName, "app-store/app-store.config.json", SNAPSHOT_BRANCH),
    getRepoJsonFile(repoFullName, "package.json", SNAPSHOT_BRANCH),
  ]);
  const packageVersion = object(packageJson)?.version;
  const marketFloor = marketVersionFloorFromConfigs({ googlePlay, appStore });
  const baseTag = resolveSnapshotCandidateBase({
    tags: tags.map((tag) => tag.name),
    marketFloor,
    packageVersion,
  });
  return { tags, baseTag };
}

async function prepareGithubDeployPlans(opts: {
  repoFullName: string;
  targets: readonly SnapshotDeployTarget[];
  tag: string;
  sha: string;
}): Promise<GithubDeployPlan[]> {
  if (!parseSnapshotCandidateTag(opts.tag)) {
    throw new Error(`snapshot 후보 태그 형식이 아닙니다: ${opts.tag}`);
  }

  return Promise.all(
    opts.targets
      .filter((target): target is "AIT" | "PLAY" => target !== "TESTFLIGHT")
      .map(async (target) => {
        const workflowFile = GITHUB_WORKFLOW[target];
        if (!workflowFile) throw new Error(`snapshot 배포 workflow가 없습니다: ${target}`);
        // workflow_dispatch API 진입점과 후보 소스 정의를 main에서 검증한 뒤,
        // main SHA에 붙인 snapshot 태그로 실행 ref를 고정한다.
        const workflow = await getWorkflowDispatchContract(
          opts.repoFullName,
          workflowFile,
          SNAPSHOT_BRANCH,
        );
        if (!workflow.dispatchable) {
          throw new Error(
            `${SNAPSHOT_BRANCH}의 ${workflowFile}에 workflow_dispatch가 없습니다.`,
          );
        }
        const dispatchRef = resolveSnapshotDeployDispatchRef(
          opts.tag,
        );
        const inputs = buildSnapshotMarketInputs(
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

export interface SnapshotDeployPreview {
  branch: typeof SNAPSHOT_BRANCH;
  sha: string;
  tag: string;
  targets: SnapshotDeployTarget[];
  destinations: SnapshotDeployDestination[];
}

/** 외부 write 전 main HEAD와 모든 테스트 배포 caller를 검증한다. */
export async function previewSnapshotDeploy(
  repoFullName: string,
  options: { marketTargets: unknown; iosBundle?: string | null },
): Promise<SnapshotDeployPreview> {
  const targets = assertSnapshotTargets(
    repoFullName,
    options.marketTargets,
    options.iosBundle,
  );
  const defaultBranch = await getRepoDefaultBranch(repoFullName);
  assertSnapshotDefaultBranch(defaultBranch);
  const [sha, context] = await Promise.all([
    resolveRefSha(repoFullName, SNAPSHOT_BRANCH),
    candidateBaseContext(repoFullName),
  ]);
  const tag = nextSnapshotCandidateTag(
    context.baseTag,
    context.tags.map((item) => item.name),
  );
  const plans = await prepareGithubDeployPlans({
    repoFullName,
    targets,
    tag,
    sha,
  });
  return {
    branch: SNAPSHOT_BRANCH,
    sha,
    tag,
    targets,
    destinations: [
      ...plans.map((plan) => ({
        target: plan.target,
        label: SNAPSHOT_DEPLOY_TARGET_KO[plan.target],
        url: `https://github.com/${repoFullName}/actions/workflows/${plan.workflowFile}`,
      })),
      ...(targets.includes("TESTFLIGHT")
        ? [{ target: "TESTFLIGHT" as const, label: SNAPSHOT_DEPLOY_TARGET_KO.TESTFLIGHT }]
        : []),
    ],
  };
}

/** 확인된 main SHA에 후보 태그를 붙인 뒤 등록된 모든 내부 테스트 채널을 실행한다. */
export async function createAndDispatchSnapshotDeploy(opts: {
  repoFullName: string;
  expectedSha: string;
  expectedTargets: readonly SnapshotDeployTarget[];
  marketTargets: unknown;
  iosBundle?: string | null;
  tag: string;
  actorLabel?: string;
}): Promise<{
  tag: string;
  sha: string;
  created: boolean;
  destinations: SnapshotDeployDestination[];
}> {
  if (!parseSnapshotCandidateTag(opts.tag)) {
    throw new Error(`snapshot 후보 태그 형식이 아닙니다: ${opts.tag}`);
  }

  const currentTargets = assertSnapshotTargets(
    opts.repoFullName,
    opts.marketTargets,
    opts.iosBundle,
  );
  if (!sameTargets(currentTargets, opts.expectedTargets)) {
    throw new Error("확인 후 테스트 배포 대상이 변경됐습니다. 다시 요청해 확인하세요.");
  }

  const currentSha = await resolveRefSha(opts.repoFullName, SNAPSHOT_BRANCH);
  if (currentSha !== opts.expectedSha) {
    throw new Error(
      `main HEAD가 ${opts.expectedSha.slice(0, 7)}에서 ${currentSha.slice(0, 7)}(으)로 변경됐습니다. 다시 요청해 확인하세요.`,
    );
  }

  const defaultBranch = await getRepoDefaultBranch(opts.repoFullName);
  assertSnapshotDefaultBranch(defaultBranch);
  // 태그를 만들기 전에 GitHub caller의 dispatch/input 계약을 모두 검증한다.
  const plans = await prepareGithubDeployPlans({
    repoFullName: opts.repoFullName,
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
      action: "snapshot.candidate.tag.create",
      entityType: "release-candidate",
      entityId: `${opts.repoFullName}@${opts.tag}`,
      payload: {
        branch: SNAPSHOT_BRANCH,
        tag: opts.tag,
        sha: opts.expectedSha,
        targets: currentTargets,
        created,
      } as object,
    },
  }).catch(() => {});

  const destinations: SnapshotDeployDestination[] = [];
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
        label: SNAPSHOT_DEPLOY_TARGET_KO[plan.target],
        url: `https://github.com/${opts.repoFullName}/actions/workflows/${plan.workflowFile}`,
      });
      await recordSnapshotDispatch(opts, {
        target: plan.target,
        workflowFile: plan.workflowFile,
        dispatchRef: plan.dispatchRef,
      });
    } catch (error) {
      failures.push(
        `${SNAPSHOT_DEPLOY_TARGET_KO[plan.target]}: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
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
        label: SNAPSHOT_DEPLOY_TARGET_KO.TESTFLIGHT,
        xcodeCloudBuild: run.buildNumber,
      });
      await recordSnapshotDispatch(opts, {
        target: "TESTFLIGHT",
        xcodeCloudBuild: run.buildNumber,
        externalRunId: run.buildRunId,
      });
    } catch (error) {
      failures.push(
        `${SNAPSHOT_DEPLOY_TARGET_KO.TESTFLIGHT}: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
      );
    }
  }

  if (failures.length > 0) {
    const succeeded = destinations.map((item) => item.label).join(", ") || "없음";
    throw new Error(
      `snapshot 후보 ${opts.tag} 일부 트리거 실패 (성공: ${succeeded}; 실패: ${failures.join(" / ")})`,
    );
  }

  return { tag: opts.tag, sha: opts.expectedSha, created, destinations };
}

async function recordSnapshotDispatch(
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
      action: "snapshot.deploy.dispatch",
      entityType: "release-candidate",
      entityId: `${opts.repoFullName}@${opts.tag}`,
      payload: {
        branch: SNAPSHOT_BRANCH,
        tag: opts.tag,
        sha: opts.expectedSha,
        ...payload,
      } as object,
    },
  }).catch(() => {});
}
