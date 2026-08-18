import { prisma } from "@/lib/prisma";
import {
  createTag,
  createOrUpdateRelease,
  upsertReleaseAsset,
  dispatchWorkflow,
  resolveRefSha,
  pushReleaseMarkerCommit,
} from "@/lib/github/write";
import { listVersionTags } from "@/lib/github/release";
import {
  getRepoJsonFile,
  getWorkflowDispatchInputNames,
} from "@/lib/github/read";
import { buildGooglePlayUploadInputs } from "@/lib/core/gplay-inputs";
import {
  shouldUseXcodeCloudForTarget,
  triggerXcodeCloudDeploy,
} from "@/lib/xcode-cloud/dispatch";
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
  getAppStoreSubmissionState,
  marketingVersionFromTag,
  type PrepareResult,
  type SubmitResult,
} from "@/lib/app-store/submit";
import type { DeployTarget } from "@/lib/core/deploy-targets";
import {
  bumpStableSemVerTag,
  normalizeStableSemVerTag,
  type Bump,
} from "@/lib/core/stable-semver";
import {
  assertTagAtOrAboveMarketFloor,
  marketVersionFloorFromConfigs,
  resolveReleaseTagWithMarketFloor,
} from "@/lib/core/market-version-floor";
import { enqueueDeployCompletionNotification } from "@/lib/notifications/deploy";

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

async function marketVersionFloor(repoFullName: string): Promise<string | null> {
  const [googlePlay, appStore] = await Promise.all([
    getRepoJsonFile(repoFullName, "play-store/google-play.config.json"),
    getRepoJsonFile(repoFullName, "app-store/app-store.config.json"),
  ]);
  return marketVersionFloorFromConfigs({ googlePlay, appStore });
}

/** 다음 릴리즈 태그 계산(dispatch 전 미리보기용). */
export async function previewNextTag(
  repoFullName: string,
  bump: Bump,
): Promise<{ latest: string | null; next: string }> {
  const [tags, floor] = await Promise.all([
    listVersionTags(repoFullName),
    marketVersionFloor(repoFullName),
  ]);
  const latest = tags[0]?.name ?? null;
  return {
    latest,
    next: resolveReleaseTagWithMarketFloor({
      latestTag: latest,
      marketFloor: floor,
      bump,
    }),
  };
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
 * tag 지정 시 그대로, 없으면 최신 태그 + bump.
 */
export async function createReleaseTagWithNotes(opts: {
  repoFullName: string;
  tag?: string;
  bump?: Bump;
  targetRef?: string;
  actorLabel?: string;
  prerelease?: boolean;
}): Promise<CreateReleaseResult> {
  const targetRef = opts.targetRef || "main";
  const baseSha = await resolveRefSha(opts.repoFullName, targetRef);

  const [tags, floor] = await Promise.all([
    listVersionTags(opts.repoFullName),
    marketVersionFloor(opts.repoFullName),
  ]);
  const tag = resolveReleaseTagWithMarketFloor({
    latestTag: tags[0]?.name ?? null,
    marketFloor: floor,
    explicitTag: opts.tag ? normalizeTag(opts.tag) : undefined,
    bump: opts.bump ?? "patch",
  });

  // 릴리즈 경계 마커 커밋을 남기고 그 커밋에 태그를 단다(커밋 히스토리 가시성).
  const { sha, marked } = await pushReleaseMarkerCommit({
    repoFullName: opts.repoFullName,
    ref: targetRef,
    sha: baseSha,
    tag,
  });

  const { created } = await createTag({ repoFullName: opts.repoFullName, tag, sha });
  const rel = await createOrUpdateRelease({
    repoFullName: opts.repoFullName,
    tag,
    name: tag,
    body: formatReleaseBody({ tag }),
    prerelease: opts.prerelease,
  });

  await prisma.auditLog
    .create({
      data: {
        actorLogin: opts.actorLabel ?? null,
        action: "release.tag.create",
        entityType: "release",
        entityId: `${opts.repoFullName}@${tag}`,
        payload: { tag, sha, baseSha, marked, created, releaseUrl: rel.url } as object,
      },
    })
    .catch(() => {});

  return { tag, sha, created, releaseUrl: rel.url };
}

/**
 * tag push 이후 실행되는 비동기 후처리.
 * 번역 생성 → DB upsert → GitHub Release 본문/배포 에셋 갱신을 멱등 수행한다.
 */
export async function generateAndPublishReleaseNotes(
  input: GenerateReleaseNoteInput,
): Promise<ReleaseNoteResult | null> {
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
  try {
    const asset = buildReleaseNotesAsset({ tag: input.version, ...translations });
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

const MARKET_WORKFLOW: Record<DeployTarget, string> = {
  AIT: "deploy-apps-in-toss.yml",
  PLAY: "deploy-google-play.yml",
  APPSTORE: "deploy-app-store.yml",
  ALL: "deploy-all.yml",
};

/**
 * PLAY 단독 배포 시, caller 워크플로에 "선언된" 입력만 감지해 항상 업로드 + 내부 테스터 배포까지
 * 진행되도록 입력을 주입한다. 검사 ref = 실제 dispatch ref(tag) — GitHub 은 dispatch 한 ref 의
 * 워크플로 정의로 입력을 검증하므로, 태그와 다른 ref(기본 브랜치)로 검사하면 통과해도 dispatch 에서
 * 422 가 날 수 있다(구버전 태그 함정).
 */
async function applyGooglePlayUploadInputs(
  repoFullName: string,
  workflowFile: string,
  tag: string,
  inputs: Record<string, string>,
): Promise<void> {
  const declared = await getWorkflowDispatchInputNames(repoFullName, workflowFile, tag);
  Object.assign(inputs, buildGooglePlayUploadInputs(declared, tag, { repoFullName, workflowFile }));
}

/**
 * 마켓 배포 dispatch. 지정 태그를 ref 로 표준 caller 워크플로우를 트리거.
 * 결과(빌드/업로드/성공)는 workflow_run webhook → ReleaseRecord + 라이프사이클 + 텔레그램 알림.
 */
export async function dispatchMarketDeploy(opts: {
  repoFullName: string;
  target: DeployTarget;
  tag: string;
  memo?: string;
  actorLabel?: string;
}): Promise<{ workflowFile?: string; xcodeCloudBuild?: number | null }> {
  const workflowFile = MARKET_WORKFLOW[opts.target];
  if (!workflowFile) throw new Error(`알 수 없는 배포 대상: ${opts.target}`);

  const floor = await marketVersionFloor(opts.repoFullName);
  assertTagAtOrAboveMarketFloor(opts.tag, floor);

  // iOS(App Store)를 Xcode Cloud 로 이관한 앱은 App Store 부분을 GH 가 아니라
  // ASC API 로 트리거한다(APPSTORE 단독, 또는 ALL 의 iOS 부분).
  const iosViaXcodeCloud = shouldUseXcodeCloudForTarget(
    opts.repoFullName,
    opts.target,
  );

  let xcodeCloudBuild: number | null | undefined;
  if (iosViaXcodeCloud) {
    const app = await prisma.app.findUnique({
      where: { repoFullName: opts.repoFullName },
      select: { id: true, iosBundle: true },
    });
    if (!app?.iosBundle) {
      throw new Error(
        `iosBundle 미설정: ${opts.repoFullName} — Xcode Cloud 트리거 불가`,
      );
    }
    const run = await triggerXcodeCloudDeploy({
      bundleId: app.iosBundle,
      repoFullName: opts.repoFullName,
      tag: opts.tag,
    });
    if (!run.buildRunId) throw new Error("Xcode Cloud 빌드 실행 ID가 없습니다.");
    xcodeCloudBuild = run.buildNumber;
    // GitHub workflow_run 대신 ASC ciBuildRun 을 mirror 하는 외부 배포 레코드.
    // scheduler 가 이 실행을 조회해 완료 상태와 Discord 알림을 수렴시킨다.
    const release = await prisma.releaseRecord.upsert({
      where: { externalRunId: run.buildRunId },
      create: {
        appId: app.id,
        version: opts.tag,
        market: "APPSTORE",
        status: "PENDING",
        workflowName: "Xcode Cloud",
        externalRunId: run.buildRunId,
        externalBuildNumber: run.buildNumber,
        triggeredBy: opts.actorLabel ?? null,
        startedAt: new Date(),
      },
      update: {
        version: opts.tag,
        status: "PENDING",
        externalBuildNumber: run.buildNumber,
        triggeredBy: opts.actorLabel ?? null,
      },
    });
    await enqueueDeployCompletionNotification({
      releaseRecordId: release.id,
      eventKey: `xcode:${run.buildRunId}:pending`,
      status: "PENDING",
    });
  }

  // GH 워크플로 dispatch. APPSTORE 단독은 Xcode Cloud 로 갔으니 GH 는 생략.
  let dispatchedWorkflow: string | undefined;
  if (!(iosViaXcodeCloud && opts.target === "APPSTORE")) {
    // 표준 caller 는 release_tag 입력을 받는다. AIT/ALL 은 memo 도 지원.
    const inputs: Record<string, string> = { release_tag: opts.tag };
    if ((opts.target === "AIT" || opts.target === "ALL") && opts.memo) {
      inputs.memo = opts.memo;
    }
    // ALL 인데 iOS 가 Xcode Cloud 면, deploy-all 의 App Store 잡은 제외한다.
    if (iosViaXcodeCloud && opts.target === "ALL") {
      inputs.deploy_app_store = "false";
    }
    // PLAY 단독: 텔레그램/백오피스에서 트리거하는 Google Play 배포는 항상 업로드 + 내부 테스터
    // 배포까지 진행한다(ALL 의 google-play 잡은 이미 upload=true 로 하드코딩되어 별도 처리 불필요).
    if (opts.target === "PLAY") {
      await applyGooglePlayUploadInputs(opts.repoFullName, workflowFile, opts.tag, inputs);
    }

    await dispatchWorkflow({
      repoFullName: opts.repoFullName,
      workflowFile,
      ref: opts.tag,
      inputs,
    });
    dispatchedWorkflow = workflowFile;
  }

  await prisma.auditLog
    .create({
      data: {
        actorLogin: opts.actorLabel ?? null,
        action: "release.deploy.dispatch",
        entityType: "release",
        entityId: `${opts.repoFullName}@${opts.tag}`,
        payload: {
          target: opts.target,
          workflowFile: dispatchedWorkflow ?? null,
          xcodeCloudBuild: xcodeCloudBuild ?? null,
          tag: opts.tag,
        } as object,
      },
    })
    .catch(() => {});

  return { workflowFile: dispatchedWorkflow, xcodeCloudBuild };
}

// ── Google Play: 내부 빌드 → 프로덕션 승격(재빌드 없이 심사 제출) ──

// 재빌드 없이 이미 올라간 versionCode 를 프로덕션 트랙으로 복사 + 심사 제출하는 org 워크플로.
const PROMOTE_WORKFLOW = "promote-google-play.yml";

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

  const declared = await getWorkflowDispatchInputNames(
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

/** 마케팅 버전의 현재 App Store 상태(라이브). null=버전 없음. */
export async function appStoreState(opts: {
  repoFullName: string;
  tag: string;
}): Promise<string | null> {
  const bundleId = await iosBundleOf(opts.repoFullName);
  return getAppStoreSubmissionState({
    bundleId,
    marketingVersion: marketingVersionFromTag(opts.tag),
  });
}
