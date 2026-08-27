import { buildDeployAllAppStoreInputs } from "@/lib/core/deploy-all-inputs";
import { MARKET_WORKFLOW, type DeployTarget } from "@/lib/core/deploy-targets";
import { buildGooglePlayUploadInputs } from "@/lib/core/gplay-inputs";
import {
  assertReleaseSourceContract,
  type ReleaseSourceContract,
  type ReleaseSourceFiles,
} from "@/lib/core/release-source-contract";
import { normalizeStableSemVerTag } from "@/lib/core/stable-semver";

// 릴리스 태그 생성과 마켓 배포 dispatch 의 순서 계약(포트 주입 — prisma/octokit 비의존).
//
// fail-closed 규칙: 소스 버전 계약 검증이 통과하기 전에는 GitHub tag, GitHub Release,
// workflow dispatch, Xcode Cloud 실행 중 무엇도 만들지 않는다. 실패는 외부 write 0회로 끝난다.
// 그래서 검증은 항상 첫 write 앞에 오고, ALL 에서도 Xcode Cloud 트리거보다 먼저다.

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
  getWorkflowDispatchInputNames(workflowFile: string, ref: string): Promise<Set<string>>;
  dispatchWorkflow(input: {
    workflowFile: string;
    ref: string;
    inputs: Record<string, string>;
  }): Promise<void>;
  dispatchXcodeCloudRelease(input: { tag: string }): Promise<{ buildNumber: number | null }>;
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
 * (이전 구현은 빈 마커 커밋을 main 에 push 하고 그 커밋에 태그를 달아, 파일 변경이 없는 커밋이
 * 릴리스 소스가 되고 브랜치 HEAD 도 함께 움직였다.)
 */
export async function createReleaseTagAtSource(opts: {
  repoFullName: string;
  tag: string;
  targetRef: string;
  prerelease?: boolean;
  releaseBody: (tag: string) => string;
  source: ReleaseSourcePort;
  writer: ReleaseTagPort;
}): Promise<CreateReleaseTagOutcome> {
  const tag = normalizeStableSemVerTag(opts.tag);

  // 태그 대상 SHA 를 한 번 확정하고, 그 SHA 의 소스 계약을 검증한 뒤에만 write 로 넘어간다.
  const sha = await opts.source.resolveRefSha(opts.targetRef);
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

export interface MarketDeployOutcome {
  workflowFile?: string;
  xcodeCloudBuild?: number | null;
  sha: string;
  contract: ReleaseSourceContract;
}

/**
 * 마켓 배포 dispatch. 지정 태그가 실제로 가리키는 SHA 의 소스 계약을 다시 검증한 다음에만
 * 외부 실행을 만든다. 이미 만들어진 잘못된 태그로 재시도해도 여기서 막힌다.
 */
export async function dispatchMarketDeployAtTag(opts: {
  repoFullName: string;
  target: DeployTarget;
  tag: string;
  memo?: string;
  iosViaXcodeCloud: boolean;
  source: ReleaseSourcePort;
  dispatcher: MarketDispatchPort;
}): Promise<MarketDeployOutcome> {
  const workflowFile = MARKET_WORKFLOW[opts.target];
  if (!workflowFile) throw new Error(`알 수 없는 배포 대상: ${opts.target}`);

  const sha = await opts.source.resolveRefSha(opts.tag);
  const files = await opts.source.readReleaseSourceFiles(sha);
  const contract = assertReleaseSourceContract({
    repoFullName: opts.repoFullName,
    tag: opts.tag,
    files,
  });

  // iOS(App Store)를 Xcode Cloud 로 이관한 앱은 App Store 부분을 GH 가 아니라 ASC API 로 트리거한다
  // (APPSTORE 단독, 또는 ALL 의 iOS 부분).
  let xcodeCloudBuild: number | null | undefined;
  if (opts.iosViaXcodeCloud) {
    const run = await opts.dispatcher.dispatchXcodeCloudRelease({ tag: opts.tag });
    xcodeCloudBuild = run.buildNumber;
  }

  // GH 워크플로 dispatch. APPSTORE 단독은 Xcode Cloud 로 갔으니 GH 는 생략.
  let dispatchedWorkflow: string | undefined;
  if (!(opts.iosViaXcodeCloud && opts.target === "APPSTORE")) {
    // 표준 caller 는 release_tag 입력을 받는다. AIT/ALL 은 memo 도 지원.
    const inputs: Record<string, string> = { release_tag: opts.tag };
    if ((opts.target === "AIT" || opts.target === "ALL") && opts.memo) {
      inputs.memo = opts.memo;
    }
    // ALL 인데 iOS 가 Xcode Cloud 면, deploy-all 의 App Store 잡은 제외한다.
    // 단 App Store 를 애초에 deploy-all 에서 뺀 repo 는 이 입력을 선언하지 않는다.
    // 선언되지 않은 입력을 보내면 GitHub 이 422 로 거부해 ALL 배포가 통째로 막힌다.
    if (opts.iosViaXcodeCloud && opts.target === "ALL") {
      const declared = await opts.dispatcher.getWorkflowDispatchInputNames(
        workflowFile,
        opts.tag,
      );
      Object.assign(inputs, buildDeployAllAppStoreInputs(declared));
    }
    // PLAY 단독: 백오피스/Discord 에서 트리거하는 Google Play 배포는 항상 업로드 + 내부 테스터
    // 배포까지 진행한다(ALL 의 google-play 잡은 이미 upload=true 로 하드코딩되어 별도 처리 불필요).
    if (opts.target === "PLAY") {
      const declared = await opts.dispatcher.getWorkflowDispatchInputNames(
        workflowFile,
        opts.tag,
      );
      Object.assign(
        inputs,
        buildGooglePlayUploadInputs(declared, opts.tag, {
          repoFullName: opts.repoFullName,
          workflowFile,
        }),
      );
    }

    await opts.dispatcher.dispatchWorkflow({ workflowFile, ref: opts.tag, inputs });
    dispatchedWorkflow = workflowFile;
  }

  return { workflowFile: dispatchedWorkflow, xcodeCloudBuild, sha, contract };
}
