import { buildDeployAllAppStoreInputs } from "@/lib/core/deploy-all-inputs";
import { MARKET_WORKFLOW, type DeployTarget } from "@/lib/core/deploy-targets";
import { buildGooglePlayUploadInputs } from "@/lib/core/gplay-inputs";
import {
  STABLE_RELEASE_AUTHORITY,
  stableReleaseAuthority,
  StableReleaseAuthorityError,
  type StableReleaseAuthority,
} from "@/lib/core/stable-release-authority";
import { normalizeStableSemVerTag } from "@/lib/core/stable-semver";

// 릴리스 태그 생성과 마켓 배포 dispatch 의 순서 계약(포트 주입 — prisma/octokit 비의존).
//
// fail-closed 규칙
// 1. 모든 검증(exact stable tag SHA, workflow_dispatch 계약, 전달할 inputs, Xcode Cloud 조건)은
//    첫 외부 write 앞에서 끝난다. 실패는 외부 write 0회로 끝난다.
// 2. 실행 순서는 GitHub 먼저, Xcode Cloud 마지막이다. GitHub dispatch 가 422 로 거부되면
//    Xcode Cloud 는 아직 아무것도 만들지 않은 상태이므로 ciBuildRuns write 가 0회로 남는다.
//    (되돌릴 수 없는 외부 실행을 가장 마지막에 둔다.)

export interface ReleaseAuthorityPort {
  /** 브랜치/SHA ref → 커밋 SHA. preview와 confirm의 태그 대상이 같아야 한다. */
  resolveRefSha(ref: string): Promise<string>;
  /** exact refs/tags/vX.Y.Z를 peel한 커밋 SHA. 브랜치와 이름이 같아도 태그만 읽는다. */
  resolveTagSha(tag: string): Promise<string>;
}

export interface ReleaseTagPort {
  createTag(input: { tag: string; sha: string }): Promise<{ created: boolean }>;
  createOrUpdateRelease(input: {
    tag: string;
    expectedSha: string;
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
    expectedTagSha: string;
  }): Promise<void>;
  /** 읽기 전용 Xcode Cloud 계약 검증(제품·repo·수동 태그 시작 조건). */
  validateXcodeCloudRelease(input: { tag: string }): Promise<void>;
  dispatchXcodeCloudRelease(input: {
    tag: string;
    expectedTagSha: string;
  }): Promise<{ buildNumber: number | null }>;
}

/** preview 단계에서 고정한 릴리스 후보. confirm 단계가 이 값을 그대로 다시 검증한다. */
export interface StableReleaseCandidate {
  repoFullName: string;
  /** default branch 이름과 그 시점의 exact SHA. */
  targetRef: string;
  sha: string;
  latestTag: string | null;
  tag: string;
  authority: typeof STABLE_RELEASE_AUTHORITY;
}

function authorityError(detail: string): never {
  throw new StableReleaseAuthorityError(detail);
}

/**
 * 릴리스 후보를 계산한다(외부 write 없음).
 *
 * default branch 의 exact SHA 를 고정하고 GitHub stable tag 계보 또는 명시 입력에서 후보를 정한다.
 * repo-local version 파일은 stable 릴리스 권한이 아니므로 읽지 않는다.
 */
export async function previewStableRelease(opts: {
  repoFullName: string;
  targetRef: string;
  latestTag: string | null;
  explicitTag?: string;
  bumpedTag: string;
  source: ReleaseAuthorityPort;
}): Promise<StableReleaseCandidate> {
  const sha = await opts.source.resolveRefSha(opts.targetRef);
  const tag = normalizeStableSemVerTag(opts.explicitTag ?? opts.bumpedTag);

  return {
    repoFullName: opts.repoFullName,
    targetRef: opts.targetRef,
    sha,
    latestTag: opts.latestTag,
    tag,
    authority: STABLE_RELEASE_AUTHORITY,
  };
}

export interface CreateReleaseTagOutcome {
  tag: string;
  sha: string;
  created: boolean;
  releaseUrl: string;
  releaseId: number;
  authority: StableReleaseAuthority;
}

/**
 * 승인된 소스 SHA 에 직접 릴리스 태그를 단다. 브랜치 ref 는 읽기만 하고 갱신하지 않는다.
 *
 * preview 에서 고정한 SHA·후보 태그를 넘기면 confirm 단계에서 그대로 다시 검증한다.
 * 그 사이 default branch가 움직였으면 write 없이 중단한다.
 */
export async function createReleaseTagAtSource(opts: {
  repoFullName: string;
  tag: string;
  targetRef: string;
  expectedSha?: string;
  prerelease?: boolean;
  releaseBody: (tag: string) => string;
  source: ReleaseAuthorityPort;
  writer: ReleaseTagPort;
}): Promise<CreateReleaseTagOutcome> {
  const tag = normalizeStableSemVerTag(opts.tag);

  // 태그 대상 SHA를 다시 확정한 뒤에만 write로 넘어간다.
  const sha = await opts.source.resolveRefSha(opts.targetRef);
  if (opts.expectedSha && opts.expectedSha !== sha) {
    authorityError(
      `확인 후 ${opts.targetRef} HEAD 가 ${opts.expectedSha.slice(0, 7)} 에서 ` +
        `${sha.slice(0, 7)} 로 변경됐습니다. 태그·Release 를 만들지 않고 중단했습니다. ` +
        "다시 확인해 새 후보로 릴리스하세요.",
    );
  }

  const { created } = await opts.writer.createTag({ tag, sha });
  const release = await opts.writer.createOrUpdateRelease({
    tag,
    expectedSha: sha,
    name: tag,
    body: opts.releaseBody(tag),
    prerelease: opts.prerelease,
  });

  const authority = stableReleaseAuthority(tag, sha);
  return { tag, sha, created, releaseUrl: release.url, releaseId: release.id, authority };
}

/** preflight 를 모두 통과해 확정된 실행 계획. 여기까지는 외부 write 가 없다. */
export interface MarketDeployPlan {
  sha: string;
  authority: StableReleaseAuthority;
  github: {
    workflowFile: string;
    ref: string;
    inputs: Record<string, string>;
    expectedTagSha: string;
  } | null;
  xcodeCloud: { tag: string; expectedTagSha: string } | null;
}

export interface MarketDeployOutcome {
  workflowFile?: string;
  xcodeCloudBuild?: number | null;
  sha: string;
  authority: StableReleaseAuthority;
}

/**
 * 배포 preflight. exact stable 태그가 가리키는 SHA, workflow_dispatch 계약, 전달할 inputs,
 * Xcode Cloud workflow/태그 조건을 **모두** 확인해 실행 계획을 확정한다. 외부 write 는 하지 않는다.
 */
export async function planMarketDeploy(opts: {
  repoFullName: string;
  target: DeployTarget;
  tag: string;
  memo?: string;
  iosViaXcodeCloud: boolean;
  source: ReleaseAuthorityPort;
  dispatcher: MarketDispatchPort;
}): Promise<MarketDeployPlan> {
  const workflowFile = MARKET_WORKFLOW[opts.target];
  if (!workflowFile) throw new Error(`알 수 없는 배포 대상: ${opts.target}`);

  const tag = normalizeStableSemVerTag(opts.tag);
  const sha = await opts.source.resolveTagSha(tag);
  const authority = stableReleaseAuthority(tag, sha);

  // APPSTORE 단독이 Xcode Cloud 로 가면 GH 워크플로는 쓰지 않는다.
  const usesGithub = !(opts.iosViaXcodeCloud && opts.target === "APPSTORE");

  let github: MarketDeployPlan["github"] = null;
  if (usesGithub) {
    const declared = await opts.dispatcher.getWorkflowDispatchContract(workflowFile, tag);
    if (!declared.dispatchable) {
      authorityError(
        `${opts.repoFullName} 의 ${workflowFile}(태그 ${tag})에 workflow_dispatch 선언이 없습니다. ` +
          "해당 태그로는 배포를 트리거할 수 없습니다.",
      );
    }

    // 표준 caller 는 release_tag 입력을 받는다. AIT/ALL 은 memo 도 지원.
    const inputs: Record<string, string> = { release_tag: tag };
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
        buildGooglePlayUploadInputs(declared.inputNames, tag, {
          repoFullName: opts.repoFullName,
          workflowFile,
        }),
      );
    }

    const undeclared = Object.keys(inputs).filter((name) => !declared.inputNames.has(name));
    if (undeclared.length > 0) {
      authorityError(
        `${opts.repoFullName} 의 ${workflowFile}(태그 ${tag})이 선언하지 않은 입력을 보낼 수 없습니다: ` +
          `${undeclared.join(", ")}. GitHub 이 422 로 거부하므로 dispatch 하지 않았습니다.`,
      );
    }

    github = { workflowFile, ref: tag, inputs, expectedTagSha: sha };
  }

  // Xcode Cloud 는 읽기 전용 계약 검증까지 preflight 에서 끝낸다(제품·repo·수동 태그 조건).
  let xcodeCloud: MarketDeployPlan["xcodeCloud"] = null;
  if (opts.iosViaXcodeCloud) {
    await opts.dispatcher.validateXcodeCloudRelease({ tag });
    xcodeCloud = { tag, expectedTagSha: sha };
  }

  return { sha, authority, github, xcodeCloud };
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
    const run = await opts.dispatcher.dispatchXcodeCloudRelease(plan.xcodeCloud);
    xcodeCloudBuild = run.buildNumber;
  }

  return { workflowFile, xcodeCloudBuild, sha: plan.sha, authority: plan.authority };
}

/** 마켓 배포: preflight 전부 → GitHub dispatch → Xcode Cloud 순서로 실행한다. */
export async function dispatchMarketDeployAtTag(opts: {
  repoFullName: string;
  target: DeployTarget;
  tag: string;
  memo?: string;
  iosViaXcodeCloud: boolean;
  source: ReleaseAuthorityPort;
  dispatcher: MarketDispatchPort;
}): Promise<MarketDeployOutcome> {
  const plan = await planMarketDeploy(opts);
  return executeMarketDeployPlan({ plan, dispatcher: opts.dispatcher });
}
