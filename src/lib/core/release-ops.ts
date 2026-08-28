import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { shouldBackofficeAutoPublishReleaseNotes } from "@/lib/core/release-ownership";
import {
  createTag,
  createOrUpdateRelease,
  upsertReleaseAsset,
  dispatchWorkflow,
  resolveRefSha,
} from "@/lib/github/write";
import { listVersionTags } from "@/lib/github/release";
import {
  getRepoJsonFile,
  getRepoDefaultBranch,
  getWorkflowDispatchContract,
} from "@/lib/github/read";
import {
  shouldUseXcodeCloudForTarget,
  validateXcodeCloudDeploy,
} from "@/lib/xcode-cloud/dispatch";
import { dispatchXcodeCloudRelease } from "@/lib/xcode-cloud/release";
import {
  generateReleaseNoteCore,
  type GenerateReleaseNoteInput,
  type ReleaseNoteResult,
} from "@/lib/core/release-notes";
import {
  buildReleaseNotesAsset,
  RELEASE_NOTES_ASSET_NAME,
} from "@/lib/core/store-notes";
import {
  RELEASE_NOTE_LOCALES,
  releaseNoteTranslations,
  type ReleaseNoteTranslations,
  type ReleaseNoteTranslationsInput,
} from "@/lib/core/release-note-locales";
import {
  prepareAppStoreSubmission,
  submitAppStoreForReview,
  createAppStoreReviewSubmission,
  removeAppStoreReviewSubmissionItem,
  cancelAppStoreReviewSubmission,
  readAppStoreReviewStatus,
  marketingVersionFromTag,
  type AppStoreReviewStatus,
  type PrepareResult,
  type SubmitResult,
} from "@/lib/app-store/submit";
import { PROMOTE_WORKFLOW, type DeployTarget } from "@/lib/core/deploy-targets";
import {
  bumpStableSemVerTag,
  normalizeStableSemVerTag,
  type Bump,
} from "@/lib/core/stable-semver";
import {
  marketVersionFloorFromConfigs,
  resolveReleaseTagWithMarketFloor,
} from "@/lib/core/market-version-floor";
import { readReleaseSourceFiles } from "@/lib/github/release-source";
import { ReleaseSourceContractError } from "@/lib/core/release-source-contract";
import {
  createReleaseTagAtSource,
  executeMarketDeployPlan,
  planMarketDeploy,
  previewStableRelease,
  type MarketDispatchPort,
  type ReleaseSourcePort,
  type StableReleaseCandidate,
} from "@/lib/core/release-orchestrator";

export type { Bump } from "@/lib/core/stable-semver";

export {
  DEPLOY_TARGET_KO,
  deployTargetsFor,
  type DeployTarget,
} from "@/lib/core/deploy-targets";

// 릴리즈/배포 오케스트레이션 코어 — Backoffice UI / Discord 공용.
// 원칙: GitHub write(태그/Release/dispatch) 후 결과는 webhook 으로 미러에 재수렴.
// 배포 dispatch 는 ReleaseRecord 를 직접 INSERT 하지 않는다(workflow_run 미러가 담당).

function normalizeTag(raw: string): string {
  return normalizeStableSemVerTag(raw);
}

export function bumpFrom(latest: string | null, bump: Bump): string {
  return bumpStableSemVerTag(latest, bump);
}

/**
 * repo-local 마켓 config 의 최고 버전. **다음 태그 추천에만** 쓴다.
 * 배포 허가 근거로 쓰지 않는다 — 마켓 원장은 이미 배포된 버전이라 "그 이상"이라는 사실만으로는
 * 태그가 가리키는 소스가 그 버전이라는 증거가 되지 못한다(v1.2.0 태그 / 소스 1.1.12 장애).
 * 실제 허가는 `assertReleaseSourceContract` 가 SHA 단위로 판단한다.
 */
async function marketVersionFloor(repoFullName: string): Promise<string | null> {
  const [googlePlay, appStore] = await Promise.all([
    getRepoJsonFile(repoFullName, "play-store/google-play.config.json"),
    getRepoJsonFile(repoFullName, "app-store/app-store.config.json"),
  ]);
  return marketVersionFloorFromConfigs({ googlePlay, appStore });
}

/**
 * 릴리즈 후보 미리보기. default branch 의 exact SHA 를 고정하고 그 SHA 의 소스 원장에서
 * 후보 태그를 확정한다. 외부 write 는 하지 않는다. confirm 단계가 이 SHA·태그를 다시 검증한다.
 */
export async function previewNextTag(
  repoFullName: string,
  bump: Bump,
  explicitTag?: string,
): Promise<StableReleaseCandidate & { next: string }> {
  const [tags, floor, targetRef] = await Promise.all([
    listVersionTags(repoFullName),
    marketVersionFloor(repoFullName),
    getRepoDefaultBranch(repoFullName),
  ]);
  const latest = tags[0]?.name ?? null;
  const candidate = await previewStableRelease({
    repoFullName,
    targetRef,
    latestTag: latest,
    explicitTag: explicitTag ? normalizeTag(explicitTag) : undefined,
    bumpedTag: resolveReleaseTagWithMarketFloor({
      latestTag: latest,
      marketFloor: floor,
      bump,
    }),
    source: releaseSourcePort(repoFullName),
  });
  return { ...candidate, next: candidate.tag };
}

export interface CreateReleaseResult {
  tag: string;
  sha: string;
  created: boolean;
  releaseUrl: string;
}

/**
 * 명시적 릴리즈 태그 + GitHub Release 를 즉시 생성한다.
 * 다국어 출시노트는 tag push webhook 의 after 작업에서 별도로 생성·발행한다.
 * tag 지정 시 그대로, 없으면 최신 태그 + 마켓 원장 중 높은 쪽에서 bump(추천 값).
 *
 * 태그는 승인된 소스 SHA 를 직접 가리키고, 대상 브랜치 HEAD 는 이 경로에서 절대 움직이지 않는다.
 * 소스 버전 계약이 깨지면 태그도 Release 도 만들지 않는다.
 */
export async function createReleaseTagWithNotes(opts: {
  repoFullName: string;
  tag?: string;
  bump?: Bump;
  targetRef?: string;
  /** preview 에서 고정한 default branch SHA. 다르면 write 없이 중단한다. */
  expectedSha?: string;
  actorLabel?: string;
  prerelease?: boolean;
}): Promise<CreateReleaseResult> {
  if (!shouldBackofficeAutoPublishReleaseNotes(opts.repoFullName, env.githubOrg())) {
    throw new ReleaseSourceContractError(
      `${env.githubOrg()}/platform 릴리스는 Platform immutable publisher만 생성할 수 있습니다.`,
    );
  }
  // targetRef 미지정이면 repo 의 실제 default branch 를 쓴다("main" 하드코딩 금지).
  const targetRef = opts.targetRef || (await getRepoDefaultBranch(opts.repoFullName));

  // 후보 태그는 소스 원장이 있는 repo 에서는 소스 버전이고, 없는 repo 에서만 bump 로 정해진다.
  const candidate = await previewStableRelease({
    repoFullName: opts.repoFullName,
    targetRef,
    latestTag: null,
    explicitTag: opts.tag ? normalizeTag(opts.tag) : undefined,
    bumpedTag: await bumpedCandidateTag(opts.repoFullName, opts.bump ?? "patch"),
    source: releaseSourcePort(opts.repoFullName),
  });

  const result = await createReleaseTagAtSource({
    repoFullName: opts.repoFullName,
    tag: candidate.tag,
    targetRef,
    expectedSha: opts.expectedSha ?? candidate.sha,
    prerelease: opts.prerelease,
    releaseBody: (created) => formatReleaseBody({ tag: created }),
    source: releaseSourcePort(opts.repoFullName),
    writer: {
      createTag: (input) => createTag({ repoFullName: opts.repoFullName, ...input }),
      createOrUpdateRelease: (input) =>
        createOrUpdateRelease({ repoFullName: opts.repoFullName, ...input }),
    },
  });

  await prisma.auditLog
    .create({
      data: {
        actorLogin: opts.actorLabel ?? null,
        action: "release.tag.create",
        entityType: "release",
        entityId: `${opts.repoFullName}@${result.tag}`,
        payload: {
          tag: result.tag,
          sha: result.sha,
          targetRef,
          contract: result.contract.kind,
          sourceVersions: result.contract.observed,
          created: result.created,
          releaseUrl: result.releaseUrl,
        } as object,
      },
    })
    .catch(() => {});

  return {
    tag: result.tag,
    sha: result.sha,
    created: result.created,
    releaseUrl: result.releaseUrl,
  };
}

/** 소스 원장이 없는 repo 를 위한 bump 후보(태그 계보와 마켓 원장 중 높은 쪽 기준). */
async function bumpedCandidateTag(repoFullName: string, bump: Bump): Promise<string> {
  const [tags, floor] = await Promise.all([
    listVersionTags(repoFullName),
    marketVersionFloor(repoFullName),
  ]);
  return resolveReleaseTagWithMarketFloor({
    latestTag: tags[0]?.name ?? null,
    marketFloor: floor,
    bump,
  });
}

/**
 * tag push 이후 실행되는 비동기 후처리.
 * 번역 생성 → DB upsert → GitHub Release 본문/배포 에셋 갱신을 멱등 수행한다.
 */
export async function generateAndPublishReleaseNotes(
  input: GenerateReleaseNoteInput,
  execution: { assertOwnership?: () => Promise<void> } = {},
): Promise<ReleaseNoteResult | null> {
  if (!shouldBackofficeAutoPublishReleaseNotes(input.repoFullName, env.githubOrg())) {
    return null;
  }
  await execution.assertOwnership?.();
  const note = await generateReleaseNoteCore(input);
  if (!note) return null;

  const row = await prisma.releaseNote.findUnique({
    where: {
      repoFullName_version: {
        repoFullName: input.repoFullName,
        version: input.version,
      },
    },
    select: {
      koKR: true,
      enUS: true,
      jaJP: true,
      zhCN: true,
      zhTW: true,
      deDE: true,
      frFR: true,
      esES: true,
      compareUrl: true,
    },
  });
  if (!row) return note;

  const translations = releaseNoteTranslations(row);
  await execution.assertOwnership?.();
  const rel = await createOrUpdateRelease({
    repoFullName: input.repoFullName,
    tag: input.version,
    name: input.version,
    body: formatReleaseBody({
      tag: input.version,
      ...translations,
      compareUrl: row.compareUrl,
    }),
  });

  // 마켓 배포 워크플로우가 다운로드할 정형 출시노트 에셋(release-notes.json).
  // 실패해도 번역과 GitHub Release 본문은 유지한다.
  const asset = buildReleaseNotesAsset({ tag: input.version, ...translations });
  if (asset) await execution.assertOwnership?.();
  try {
    if (asset) {
      await upsertReleaseAsset({
        repoFullName: input.repoFullName,
        releaseId: rel.id,
        name: RELEASE_NOTES_ASSET_NAME,
        contentType: "application/json",
        data: asset,
      });
    }
  } catch (e) {
    console.warn(`[release-ops] ${RELEASE_NOTES_ASSET_NAME} 업로드 실패: ${(e as Error).message}`);
  }

  return note;
}

/** GitHub Release 본문(마켓 무관 다국어 출시노트 + compare 링크). */
export function formatReleaseBody(
  n: { tag: string; compareUrl?: string | null } & ReleaseNoteTranslationsInput,
): string {
  const parts: string[] = [];
  for (const { field, heading } of RELEASE_NOTE_LOCALES) {
    const body = n[field]?.trim();
    if (body) parts.push(`## ${heading}\n\n${body}`);
  }
  if (parts.length === 0) parts.push(`Release ${n.tag}`);
  if (n.compareUrl) parts.push(`---\n\n**Changes:** ${n.compareUrl}`);
  return parts.join("\n\n");
}

/** repo 단위 릴리스 소스 조회 포트(SHA 확정 + 계약 입력 읽기). */
function releaseSourcePort(repoFullName: string): ReleaseSourcePort {
  return {
    resolveRefSha: (ref) => resolveRefSha(repoFullName, ref),
    readReleaseSourceFiles: (sha) => readReleaseSourceFiles(repoFullName, sha),
  };
}

/**
 * 마켓 배포 dispatch. 지정 태그를 ref 로 표준 caller 워크플로우를 트리거.
 * 결과(빌드/업로드/성공)는 workflow_run webhook → ReleaseRecord + 라이프사이클 + 알림.
 *
 * dispatch 전에 태그가 가리키는 정확한 SHA 의 소스 버전 계약을 다시 검증한다. 이미 만들어진
 * 잘못된 태그로 PLAY/AIT/ALL 을 재시도해도 외부 실행이 하나도 생기지 않는다.
 */
export async function dispatchMarketDeploy(opts: {
  repoFullName: string;
  target: DeployTarget;
  tag: string;
  memo?: string;
  actorLabel?: string;
}): Promise<{ workflowFile?: string; xcodeCloudBuild?: number | null }> {
  const dispatcher: MarketDispatchPort = {
    getWorkflowDispatchContract: (workflowFile, ref) =>
      getWorkflowDispatchContract(opts.repoFullName, workflowFile, ref),
    dispatchWorkflow: (input) =>
      dispatchWorkflow({ repoFullName: opts.repoFullName, ...input }),
    validateXcodeCloudRelease: async (input) => {
      const bundleId = await iosBundleOf(opts.repoFullName);
      await validateXcodeCloudDeploy({
        bundleId,
        repoFullName: opts.repoFullName,
        tag: input.tag,
      });
    },
    dispatchXcodeCloudRelease: (input) =>
      dispatchXcodeCloudRelease({
        repoFullName: opts.repoFullName,
        tag: input.tag,
        actorLabel: opts.actorLabel,
      }),
  };

  // preflight 전부 → GitHub dispatch → Xcode Cloud. 계획 수립까지는 외부 write 가 없다.
  const plan = await planMarketDeploy({
    repoFullName: opts.repoFullName,
    target: opts.target,
    tag: opts.tag,
    memo: opts.memo,
    // iOS(App Store)를 Xcode Cloud 로 이관한 앱은 App Store 부분을 ASC API 로 트리거한다.
    iosViaXcodeCloud: shouldUseXcodeCloudForTarget(opts.repoFullName, opts.target),
    source: releaseSourcePort(opts.repoFullName),
    dispatcher,
  });

  const result = await executeMarketDeployPlan({ plan, dispatcher });

  await prisma.auditLog
    .create({
      data: {
        actorLogin: opts.actorLabel ?? null,
        action: "release.deploy.dispatch",
        entityType: "release",
        entityId: `${opts.repoFullName}@${result.contract.tag}`,
        payload: {
          target: opts.target,
          tag: result.contract.tag,
          // 검증된 태그 SHA 와 실제 dispatch 결과만 남긴다.
          sha: result.sha,
          contract: result.contract.kind,
          sourceVersions: result.contract.observed,
          workflowFile: result.workflowFile ?? null,
          xcodeCloudBuild: result.xcodeCloudBuild ?? null,
        } as object,
      },
    })
    .catch(() => {});

  return {
    workflowFile: result.workflowFile,
    xcodeCloudBuild: result.xcodeCloudBuild,
  };
}

// ── Google Play: 내부 빌드 → 프로덕션 승격(재빌드 없이 심사 제출) ──

/** repo+version 의 저장된 다국어 출시노트. 없으면 null. */
async function loadReleaseNoteTranslations(
  repoFullName: string,
  version: string,
): Promise<ReleaseNoteTranslations | null> {
  const row = await prisma.releaseNote.findUnique({
    where: { repoFullName_version: { repoFullName, version } },
    select: {
      koKR: true,
      enUS: true,
      jaJP: true,
      zhCN: true,
      zhTW: true,
      deDE: true,
      frFR: true,
      esES: true,
    },
  });
  return row ? releaseNoteTranslations(row) : null;
}

/**
 * 이미 internal 트랙에 올라간 빌드를 production 트랙으로 승격(= 심사 제출).
 * 재빌드하지 않고 promote-google-play.yml 을 dispatch 한다. 결과는 workflow_run webhook 미러.
 * 출시노트는 사전 생성돼 있어야 하며(태그 시점), 없으면 승격을 막는다.
 */
export async function promoteGooglePlay(opts: {
  repoFullName: string;
  tag: string;
  rollout?: number; // 0<f<=1 staged rollout. 미지정 시 완전 출시.
  actorLabel?: string;
}): Promise<{ workflowFile: string }> {
  const notes = await loadReleaseNoteTranslations(opts.repoFullName, opts.tag);
  if (!notes) {
    throw new Error(
      `출시노트가 아직 생성되지 않았습니다(${opts.tag}). 잠시 후 다시 시도하세요.`,
    );
  }

  const { inputNames: declared } = await getWorkflowDispatchContract(
    opts.repoFullName,
    PROMOTE_WORKFLOW,
    opts.tag,
  );
  const inputs: Record<string, string> = { release_tag: opts.tag };
  if (declared.has("from_track")) inputs.from_track = "internal";
  if (declared.has("to_track")) inputs.to_track = "production";
  if (declared.has("release_status")) inputs.release_status = "completed";
  if (opts.rollout != null && declared.has("rollout")) {
    inputs.rollout = String(opts.rollout);
  }

  await dispatchWorkflow({
    repoFullName: opts.repoFullName,
    workflowFile: PROMOTE_WORKFLOW,
    ref: opts.tag,
    inputs,
  });

  await prisma.auditLog
    .create({
      data: {
        actorLogin: opts.actorLabel ?? null,
        action: "release.promote.dispatch",
        entityType: "release",
        entityId: `${opts.repoFullName}@${opts.tag}`,
        payload: { target: "PLAY", to: "production", tag: opts.tag } as object,
      },
    })
    .catch(() => {});

  return { workflowFile: PROMOTE_WORKFLOW };
}

// ── App Store: 심사 준비(스테이징) / 심사 제출(별도 확인) ──

/** repoFullName → iosBundle. 미설정이면 throw. */
async function iosBundleOf(repoFullName: string): Promise<string> {
  const app = await prisma.app.findUnique({
    where: { repoFullName },
    select: { iosBundle: true },
  });
  if (!app?.iosBundle) {
    throw new Error(`iosBundle 미설정: ${repoFullName} — App Store 심사 처리 불가`);
  }
  return app.iosBundle;
}

/**
 * App Store 심사 준비(멱등): 버전 확보 + 언어별 what's new 주입 + 최신 VALID 빌드 연결.
 * 빌드 처리 중이면 ready=false 로 사유를 담아 반환한다(에러 아님).
 */
export async function prepareAppStore(opts: {
  repoFullName: string;
  tag: string;
  actorLabel?: string;
}): Promise<PrepareResult> {
  const bundleId = await iosBundleOf(opts.repoFullName);
  const notes = await loadReleaseNoteTranslations(opts.repoFullName, opts.tag);
  const result = await prepareAppStoreSubmission({
    bundleId,
    marketingVersion: marketingVersionFromTag(opts.tag),
    notes: notes ?? {},
  });

  await prisma.auditLog
    .create({
      data: {
        actorLogin: opts.actorLabel ?? null,
        action: "release.appstore.prepare",
        entityType: "release",
        entityId: `${opts.repoFullName}@${opts.tag}`,
        payload: {
          ready: result.ready,
          appStoreState: result.appStoreState,
          localizationsUpdated: result.localizationsUpdated,
          buildAttached: result.buildAttached,
        } as object,
      },
    })
    .catch(() => {});

  return result;
}

/** App Store 심사 제출(되돌리기 어려움 — 호출부에서 명시 확인 후). */
export async function submitAppStore(opts: {
  repoFullName: string;
  tag: string;
  actorLabel?: string;
}): Promise<SubmitResult> {
  const bundleId = await iosBundleOf(opts.repoFullName);
  const result = await submitAppStoreForReview({
    bundleId,
    marketingVersion: marketingVersionFromTag(opts.tag),
  });

  await prisma.auditLog
    .create({
      data: {
        actorLogin: opts.actorLabel ?? null,
        action: "release.appstore.submit",
        entityType: "release",
        entityId: `${opts.repoFullName}@${opts.tag}`,
        payload: { reviewSubmissionId: result.reviewSubmissionId, tag: opts.tag } as object,
      },
    })
    .catch(() => {});

  return result;
}

/** 마케팅 버전의 심사 단계 라이브 조회(카드 버튼 구성·실행 가드 공용). */
export async function appStoreReviewStatus(opts: {
  repoFullName: string;
  tag: string;
}): Promise<AppStoreReviewStatus> {
  const bundleId = await iosBundleOf(opts.repoFullName);
  return readAppStoreReviewStatus({
    bundleId,
    marketingVersion: marketingVersionFromTag(opts.tag),
  });
}

/** App Store 심사 생성(제출 아님): 준비 + 열린 제출에 이 버전을 항목으로 추가. */
export async function createAppStoreReview(opts: {
  repoFullName: string;
  tag: string;
  actorLabel?: string;
}): Promise<{ prepare: PrepareResult; reviewSubmissionId?: string }> {
  const bundleId = await iosBundleOf(opts.repoFullName);
  const notes = await loadReleaseNoteTranslations(opts.repoFullName, opts.tag);
  const result = await createAppStoreReviewSubmission({
    bundleId,
    marketingVersion: marketingVersionFromTag(opts.tag),
    notes: notes ?? {},
  });

  await recordReleaseAudit(opts, "release.appstore.review.create", {
    ready: result.prepare.ready,
    appStoreState: result.prepare.appStoreState,
    reviewSubmissionId: result.reviewSubmissionId ?? null,
  });

  return result;
}

/** App Store 심사 생성 삭제(미제출 항목만). */
export async function removeAppStoreReview(opts: {
  repoFullName: string;
  tag: string;
  actorLabel?: string;
}): Promise<{ removed: boolean }> {
  const bundleId = await iosBundleOf(opts.repoFullName);
  const result = await removeAppStoreReviewSubmissionItem({
    bundleId,
    marketingVersion: marketingVersionFromTag(opts.tag),
  });

  await recordReleaseAudit(opts, "release.appstore.review.remove", { tag: opts.tag });
  return result;
}

/** App Store 제출 취소(심사 대기·진행 중 회수). */
export async function cancelAppStoreReview(opts: {
  repoFullName: string;
  tag: string;
  actorLabel?: string;
}): Promise<{ reviewSubmissionId: string }> {
  const bundleId = await iosBundleOf(opts.repoFullName);
  const result = await cancelAppStoreReviewSubmission({
    bundleId,
    marketingVersion: marketingVersionFromTag(opts.tag),
  });

  await recordReleaseAudit(opts, "release.appstore.review.cancel", {
    reviewSubmissionId: result.reviewSubmissionId,
  });
  return result;
}

async function recordReleaseAudit(
  opts: { repoFullName: string; tag: string; actorLabel?: string },
  action: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await prisma.auditLog
    .create({
      data: {
        actorLogin: opts.actorLabel ?? null,
        action,
        entityType: "release",
        entityId: `${opts.repoFullName}@${opts.tag}`,
        payload: payload as object,
      },
    })
    .catch(() => {});
}
