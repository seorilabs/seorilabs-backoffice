import { buildDeployAllAppStoreInputs } from "@/lib/core/deploy-all-inputs";
import { MARKET_WORKFLOW, type DeployTarget } from "@/lib/core/deploy-targets";
import { buildGooglePlayUploadInputs } from "@/lib/core/gplay-inputs";
import {
  assertReleaseSourceContract,
  readReleaseSourceVersion,
  resolveStableReleaseCandidateTag,
  ReleaseSourceContractError,
  type ReleaseSourceContract,
  type ReleaseSourceFiles,
  type ReleaseSourceVersion,
} from "@/lib/core/release-source-contract";
import { normalizeStableSemVerTag } from "@/lib/core/stable-semver";

// 릴리스 태그 생성과 마켓 배포 dispatch 의 순서 계약(포트 주입 — prisma/octokit 비의존).
//
// fail-closed 규칙
// 1. 모든 검증(소스 버전, workflow_dispatch 계약, 전달할 inputs, Xcode Cloud workflow/tag 조건)은
//    첫 외부 write 앞에서 끝난다. 실패는 외부 write 0회로 끝난다.
// 2. 실행 순서는 GitHub 먼저, Xcode Cloud 마지막이다. GitHub dispatch 가 422 로 거부되면
//    Xcode Cloud 는 아직 아무것도 만들지 않은 상태이므로 ciBuildRuns write 가 0회로 남는다.
//    (되돌릴 수 없는 외부 실행을 가장 마지막에 둔다.)

export interface ReleaseSourcePort {
  /** ref(브랜치/태그/SHA) → 커밋 SHA. 계약 검증과 태그 대상이 같은 SHA 여야 한다. */
  resolveRefSha(ref: string): Promise<string>;
  readReleaseSourceFiles(sha: string): Promise<ReleaseSourceFiles>;
}

export interface ReleaseTagPort {
  createTag(input: { tag: string; sha: string }): Promise<{ created: boolean }>;
  createOrUpdateRelease(input: {
    tag: string;
    name: string;
    body: string;
    prerelease?: boolean;
  }): Promise<{ url: string; id: number }>;
}

export interface MarketDispatchPort {
  /** 실제 dispatch ref 의 workflow_dispatch 선언(존재 여부 + 입력 이름). */
  getWorkflowDispatchContract(
    workflowFile: string,
    ref: string,
  ): Promise<{ dispatchable: boolean; inputNames: Set<string> }>;
  dispatchWorkflow(input: {
    workflowFile: string;
    ref: string;
    inputs: Record<string, string>;
  }): Promise<void>;
  /** 읽기 전용 Xcode Cloud 계약 검증(제품·repo·수동 태그 시작 조건). */
  validateXcodeCloudRelease(input: { tag: string }): Promise<void>;
  dispatchXcodeCloudRelease(input: { tag: string }): Promise<{ buildNumber: number | null }>;
}

/** preview 단계에서 고정한 릴리스 후보. confirm 단계가 이 값을 그대로 다시 검증한다. */
export interface StableReleaseCandidate {
  repoFullName: string;
  /** default branch 이름과 그 시점의 exact SHA. */
  targetRef: string;
  sha: string;
  latestTag: string | null;
  tag: string;
  contract: ReleaseSourceVersion["kind"];
  sourceVersion: string | null;
  observed: Record<string, string>;
  /** pinned-source 라서 bump 대신 소스 버전을 후보로 썼는지. */
  bumpIgnored: boolean;
}

function contractError(detail: string): never {
  throw new ReleaseSourceContractError(detail);
}

/**
 * 릴리스 후보를 계산한다(외부 write 없음).
 *
 * default branch 의 exact SHA 를 고정하고 그 SHA 의 소스 원장에서 후보 태그를 정한다.
 * pinned-source repo 는 bump 로 원장에 없는 버전을 만들지 않는다.
 */
export async function previewStableRelease(opts: {
  repoFullName: string;
  targetRef: string;
  latestTag: string | null;
  explicitTag?: string;
  bumpedTag: string;
  source: ReleaseSourcePort;
}): Promise<StableReleaseCandidate> {
  const sha = await opts.source.resolveRefSha(opts.targetRef);
  const files = await opts.source.readReleaseSourceFiles(sha);
  const sourceVersion = readReleaseSourceVersion({
    repoFullName: opts.repoFullName,
    files,
  });
  const candidate = resolveStableReleaseCandidateTag({
    repoFullName: opts.repoFullName,
    source: sourceVersion,
    explicitTag: opts.explicitTag,
    bumpedTag: opts.bumpedTag,
  });

  return {
    repoFullName: opts.repoFullName,
    targetRef: opts.targetRef,
    sha,
    latestTag: opts.latestTag,
    tag: candidate.tag,
    contract: sourceVersion.kind,
    sourceVersion: sourceVersion.sourceVersion,
    observed: sourceVersion.observed,
    bumpIgnored: candidate.bumpIgnored,
  };
}

export interface CreateReleaseTagOutcome {
  tag: string;
  sha: string;
  created: boolean;
  releaseUrl: string;
  releaseId: number;
  contract: ReleaseSourceContract;
}

/**
 * 승인된 소스 SHA 에 직접 릴리스 태그를 단다. 브랜치 ref 는 읽기만 하고 갱신하지 않는다.
 *
 * preview 에서 고정한 SHA·후보 태그를 넘기면 confirm 단계에서 그대로 다시 검증한다.
 * 그 사이 default branch 가 움직였거나 소스 버전이 바뀌었으면 write 없이 중단한다.
 */
export async function createReleaseTagAtSource(opts: {
  repoFullName: string;
  tag: string;
  targetRef: string;
  expectedSha?: string;
  prerelease?: boolean;
  releaseBody: (tag: string) => string;
  source: ReleaseSourcePort;
  writer: ReleaseTagPort;
}): Promise<CreateReleaseTagOutcome> {
  const tag = normalizeStableSemVerTag(opts.tag);

  // 태그 대상 SHA 를 한 번 확정하고, 그 SHA 의 소스 계약을 검증한 뒤에만 write 로 넘어간다.
  const sha = await opts.source.resolveRefSha(opts.targetRef);
  if (opts.expectedSha && opts.expectedSha !== sha) {
    contractError(
      `확인 후 ${opts.targetRef} HEAD 가 ${opts.expectedSha.slice(0, 7)} 에서 ` +
        `${sha.slice(0, 7)} 로 변경됐습니다. 태그·Release 를 만들지 않고 중단했습니다. ` +
        "다시 확인해 새 후보로 릴리스하세요.",
    );
  }

  const files = await opts.source.readReleaseSourceFiles(sha);
  const contract = assertReleaseSourceContract({
    repoFullName: opts.repoFullName,
    tag,
    files,
  });

  const { created } = await opts.writer.createTag({ tag, sha });
  const release = await opts.writer.createOrUpdateRelease({
    tag,
    name: tag,
    body: opts.releaseBody(tag),
    prerelease: opts.prerelease,
  });

  return { tag, sha, created, releaseUrl: release.url, releaseId: release.id, contract };
}

/** preflight 를 모두 통과해 확정된 실행 계획. 여기까지는 외부 write 가 없다. */
export interface MarketDeployPlan {
  sha: string;
  contract: ReleaseSourceContract;
  github: { workflowFile: string; ref: string; inputs: Record<string, string> } | null;
  xcodeCloud: { tag: string } | null;
}

export interface MarketDeployOutcome {
  workflowFile?: string;
  xcodeCloudBuild?: number | null;
  sha: string;
  contract: ReleaseSourceContract;
}

/**
 * 배포 preflight. 태그가 가리키는 exact SHA, 소스 버전, workflow_dispatch 계약, 전달할 inputs,
 * Xcode Cloud workflow/태그 조건을 **모두** 확인해 실행 계획을 확정한다. 외부 write 는 하지 않는다.
 */
export async function planMarketDeploy(opts: {
  repoFullName: string;
  target: DeployTarget;
  tag: string;
  memo?: string;
  iosViaXcodeCloud: boolean;
  source: ReleaseSourcePort;
  dispatcher: MarketDispatchPort;
}): Promise<MarketDeployPlan> {
  const workflowFile = MARKET_WORKFLOW[opts.target];
  if (!workflowFile) throw new Error(`알 수 없는 배포 대상: ${opts.target}`);

  const sha = await opts.source.resolveRefSha(opts.tag);
  const files = await opts.source.readReleaseSourceFiles(sha);
  const contract = assertReleaseSourceContract({
    repoFullName: opts.repoFullName,
    tag: opts.tag,
    files,
  });

  // APPSTORE 단독이 Xcode Cloud 로 가면 GH 워크플로는 쓰지 않는다.
  const usesGithub = !(opts.iosViaXcodeCloud && opts.target === "APPSTORE");

  let github: MarketDeployPlan["github"] = null;
  if (usesGithub) {
    const declared = await opts.dispatcher.getWorkflowDispatchContract(
      workflowFile,
      opts.tag,
    );
    if (!declared.dispatchable) {
      contractError(
        `${opts.repoFullName} 의 ${workflowFile}(태그 ${opts.tag})에 workflow_dispatch 선언이 없습니다. ` +
          "해당 태그로는 배포를 트리거할 수 없습니다.",
      );
    }

    // 표준 caller 는 release_tag 입력을 받는다. AIT/ALL 은 memo 도 지원.
    const inputs: Record<string, string> = { release_tag: opts.tag };
    if ((opts.target === "AIT" || opts.target === "ALL") && opts.memo) {
      inputs.memo = opts.memo;
    }
    // ALL 인데 iOS 가 Xcode Cloud 면, deploy-all 의 App Store 잡은 제외한다.
    // 단 App Store 를 애초에 deploy-all 에서 뺀 repo 는 이 입력을 선언하지 않는다.
    // 선언되지 않은 입력을 보내면 GitHub 이 422 로 거부해 ALL 배포가 통째로 막힌다.
    if (opts.iosViaXcodeCloud && opts.target === "ALL") {
      Object.assign(inputs, buildDeployAllAppStoreInputs(declared.inputNames));
    }
    // PLAY 단독: 백오피스/Discord 에서 트리거하는 Google Play 배포는 항상 업로드 + 내부 테스터
    // 배포까지 진행한다(ALL 의 google-play 잡은 이미 upload=true 로 하드코딩되어 별도 처리 불필요).
    if (opts.target === "PLAY") {
      Object.assign(
        inputs,
        buildGooglePlayUploadInputs(declared.inputNames, opts.tag, {
          repoFullName: opts.repoFullName,
          workflowFile,
        }),
      );
    }

    const undeclared = Object.keys(inputs).filter((name) => !declared.inputNames.has(name));
    if (undeclared.length > 0) {
      contractError(
        `${opts.repoFullName} 의 ${workflowFile}(태그 ${opts.tag})이 선언하지 않은 입력을 보낼 수 없습니다: ` +
          `${undeclared.join(", ")}. GitHub 이 422 로 거부하므로 dispatch 하지 않았습니다.`,
      );
    }

    github = { workflowFile, ref: opts.tag, inputs };
  }

  // Xcode Cloud 는 읽기 전용 계약 검증까지 preflight 에서 끝낸다(제품·repo·수동 태그 조건).
  let xcodeCloud: MarketDeployPlan["xcodeCloud"] = null;
  if (opts.iosViaXcodeCloud) {
    await opts.dispatcher.validateXcodeCloudRelease({ tag: opts.tag });
    xcodeCloud = { tag: opts.tag };
  }

  return { sha, contract, github, xcodeCloud };
}

/**
 * 확정된 계획을 실행한다. GitHub dispatch 가 먼저이고 Xcode Cloud 가 마지막이다.
 * GitHub 이 422 등으로 거부하면 여기서 throw 되어 Xcode Cloud write 는 0회로 남는다.
 */
export async function executeMarketDeployPlan(opts: {
  plan: MarketDeployPlan;
  dispatcher: MarketDispatchPort;
}): Promise<MarketDeployOutcome> {
  const { plan } = opts;

  let workflowFile: string | undefined;
  if (plan.github) {
    await opts.dispatcher.dispatchWorkflow(plan.github);
    workflowFile = plan.github.workflowFile;
  }

  let xcodeCloudBuild: number | null | undefined;
  if (plan.xcodeCloud) {
    const run = await opts.dispatcher.dispatchXcodeCloudRelease({ tag: plan.xcodeCloud.tag });
    xcodeCloudBuild = run.buildNumber;
  }

  return { workflowFile, xcodeCloudBuild, sha: plan.sha, contract: plan.contract };
}

/** 마켓 배포: preflight 전부 → GitHub dispatch → Xcode Cloud 순서로 실행한다. */
export async function dispatchMarketDeployAtTag(opts: {
  repoFullName: string;
  target: DeployTarget;
  tag: string;
  memo?: string;
  iosViaXcodeCloud: boolean;
  source: ReleaseSourcePort;
  dispatcher: MarketDispatchPort;
}): Promise<MarketDeployOutcome> {
  const plan = await planMarketDeploy(opts);
  return executeMarketDeployPlan({ plan, dispatcher: opts.dispatcher });
}
