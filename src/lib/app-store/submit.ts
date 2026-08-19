// App Store 심사 제출 — 백오피스 ASC API 직접 호출.
//
// iOS 빌드는 Xcode Cloud(happy-farm/crossword) 또는 GH 워크플로 xcodebuild -exportArchive
// (destination=upload) 로 App Store Connect 에 올라온다. 이 모듈은 경로와 무관하게
// bundleId + 마케팅 버전만으로 "버전 생성 → 언어별 what's new 주입 → 빌드 연결 → 심사 제출"
// 을 수행한다. 빌드 처리는 업로드 후 비동기(10~30분)라 prepare 와 submit 을 분리한다.

import { asc, asArray } from "@/lib/app-store/asc-client";
import {
  RELEASE_NOTE_LOCALES,
  type ReleaseNoteTranslationsInput,
} from "@/lib/core/release-note-locales";

const PLATFORM = "IOS";

// appStoreState 중 메타데이터/빌드 편집이 가능한 상태(심사 준비 대상).
const EDITABLE_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);

/** vX.Y.Z / X.Y.Z → 마케팅 버전(X.Y.Z). */
export function marketingVersionFromTag(tag: string): string {
  return tag.trim().replace(/^v/i, "").trim();
}

/** bundleId → App Store Connect app id. 없으면 throw. */
async function findAppId(bundleId: string): Promise<string> {
  const doc = await asc(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
  const app = asArray(doc.data)[0];
  if (!app) throw new Error(`App Store Connect 앱 없음(bundleId=${bundleId})`);
  return app.id;
}

interface VersionInfo {
  id: string;
  appStoreState: string;
}

/** 마케팅 버전 문자열의 appStoreVersion 조회, 없으면 생성. */
async function findOrCreateVersion(
  appId: string,
  versionString: string,
): Promise<VersionInfo> {
  const existing = await asc(
    `/v1/apps/${appId}/appStoreVersions?filter[platform]=${PLATFORM}` +
      `&filter[versionString]=${encodeURIComponent(versionString)}&limit=1`,
  );
  const found = asArray(existing.data)[0];
  if (found) {
    return { id: found.id, appStoreState: String(found.attributes?.appStoreState ?? "") };
  }
  const created = await asc("/v1/appStoreVersions", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "appStoreVersions",
        attributes: { platform: PLATFORM, versionString },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    }),
  });
  const ver = asArray(created.data)[0];
  return { id: ver?.id ?? "", appStoreState: String(ver?.attributes?.appStoreState ?? "") };
}

/** 앱에 이미 등록된 로케일에만 whatsNew 주입(미등록 로케일은 건너뜀). */
async function applyLocalizations(
  versionId: string,
  notes: ReleaseNoteTranslationsInput,
): Promise<string[]> {
  const whatsNewByAscLocale = new Map<string, string>();
  for (const { field, ascLocale } of RELEASE_NOTE_LOCALES) {
    const body = notes[field]?.trim();
    if (body) whatsNewByAscLocale.set(ascLocale, body);
  }
  if (whatsNewByAscLocale.size === 0) return [];

  const locs = await asc(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`,
  );
  const updated: string[] = [];
  for (const loc of asArray(locs.data)) {
    const locale = String(loc.attributes?.locale ?? "");
    const whatsNew = whatsNewByAscLocale.get(locale);
    if (!whatsNew) continue;
    await asc(`/v1/appStoreVersionLocalizations/${loc.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        data: {
          type: "appStoreVersionLocalizations",
          id: loc.id,
          attributes: { whatsNew },
        },
      }),
    });
    updated.push(locale);
  }
  return updated;
}

/** 마케팅 버전의 최신 VALID 빌드를 버전에 연결. 없으면 연결 안 함. */
async function attachLatestValidBuild(
  appId: string,
  versionId: string,
  versionString: string,
): Promise<{ attached: boolean; buildVersion: string | null }> {
  const builds = await asc(
    `/v1/builds?filter[app]=${appId}` +
      `&filter[preReleaseVersion.version]=${encodeURIComponent(versionString)}` +
      `&sort=-version&limit=50`,
  );
  const valid = asArray(builds.data).find(
    (b) => String(b.attributes?.processingState ?? "") === "VALID",
  );
  if (!valid) return { attached: false, buildVersion: null };

  await asc(`/v1/appStoreVersions/${versionId}/relationships/build`, {
    method: "PATCH",
    body: JSON.stringify({ data: { type: "builds", id: valid.id } }),
  });
  return { attached: true, buildVersion: String(valid.attributes?.version ?? "") || null };
}

export interface PrepareResult {
  appId: string;
  versionId: string;
  versionString: string;
  appStoreState: string;
  localizationsUpdated: string[];
  buildAttached: boolean;
  buildVersion: string | null;
  /** 빌드 연결 + 편집 가능 상태 → 심사 제출 가능. */
  ready: boolean;
  reason?: string;
}

/**
 * 심사 준비(멱등): 버전 확보 → 언어별 what's new 주입 → 최신 VALID 빌드 연결.
 * 빌드가 아직 처리 중이면 ready=false(에러 아님) 로 사유를 담아 반환한다.
 */
export async function prepareAppStoreSubmission(opts: {
  bundleId: string;
  marketingVersion: string;
  notes: ReleaseNoteTranslationsInput;
}): Promise<PrepareResult> {
  const appId = await findAppId(opts.bundleId);
  const version = await findOrCreateVersion(appId, opts.marketingVersion);
  const editable = EDITABLE_STATES.has(version.appStoreState);

  // 편집 불가 상태(이미 심사 대기/진행 중)면 노트/빌드 수정은 건너뛴다.
  const localizationsUpdated = editable
    ? await applyLocalizations(version.id, opts.notes)
    : [];
  const build = editable
    ? await attachLatestValidBuild(appId, version.id, opts.marketingVersion)
    : { attached: false, buildVersion: null };

  const ready = editable && build.attached;
  const reason = !editable
    ? `현재 상태(${version.appStoreState})에서는 편집할 수 없습니다.`
    : !build.attached
      ? "처리 완료(VALID)된 빌드가 아직 없습니다. 잠시 후 다시 시도하세요."
      : undefined;

  return {
    appId,
    versionId: version.id,
    versionString: opts.marketingVersion,
    appStoreState: version.appStoreState,
    localizationsUpdated,
    buildAttached: build.attached,
    buildVersion: build.buildVersion,
    ready,
    reason,
  };
}

// 아직 종료되지 않은 심사 제출 상태. COMPLETE 는 이미 끝난 제출이라 제외한다.
const OPEN_SUBMISSION_STATES = [
  "READY_FOR_REVIEW",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "UNRESOLVED_ISSUES",
  "COMPLETING",
  "CANCELING",
] as const;

// 제출 뒤 취소(canceled=true)가 가능한 상태. 심사 대기·진행 중에만 회수할 수 있다.
const CANCELABLE_SUBMISSION_STATES = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES"]);

/** 앱의 열린 reviewSubmission id. 없으면 null. */
async function findOpenReviewSubmission(
  appId: string,
): Promise<{ id: string; state: string } | null> {
  const open = await asc(
    `/v1/reviewSubmissions?filter[app]=${appId}` +
      `&filter[state]=${OPEN_SUBMISSION_STATES.join(",")}&limit=1`,
  ).catch(() => null);
  const existing = open ? asArray(open.data)[0] : null;
  return existing
    ? { id: existing.id, state: String(existing.attributes?.state ?? "") }
    : null;
}

/** 열린 제출에서 해당 appStoreVersion 을 가리키는 항목 id. 없으면 null. */
async function findSubmissionItem(
  submissionId: string,
  versionId: string,
): Promise<string | null> {
  const items = await asc(`/v1/reviewSubmissions/${submissionId}/items?limit=50`).catch(
    () => null,
  );
  if (!items) return null;
  const match = asArray(items.data).find(
    (item) => item.relationships?.appStoreVersion?.data?.id === versionId,
  );
  return match?.id ?? null;
}

/** 열린 제출에 appStoreVersion 항목을 추가. 이미 있으면 무시(멱등). */
async function addSubmissionItem(submissionId: string, versionId: string): Promise<void> {
  await asc("/v1/reviewSubmissionItems", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
          appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
        },
      },
    }),
  }).catch((e) => {
    if (!/already|exist|duplicate/i.test((e as Error).message)) throw e;
  });
}

/** 앱의 열린 reviewSubmission(미제출) 조회, 없으면 생성. */
async function findOrCreateReviewSubmission(appId: string): Promise<string> {
  const existing = await findOpenReviewSubmission(appId);
  if (existing) return existing.id;

  const created = await asc("/v1/reviewSubmissions", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "reviewSubmissions",
        attributes: { platform: PLATFORM },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    }),
  });
  const sub = asArray(created.data)[0];
  if (!sub) throw new Error("reviewSubmission 생성 실패");
  return sub.id;
}

export interface SubmitResult {
  reviewSubmissionId: string;
  versionId: string;
  submitted: boolean;
}

/**
 * 심사 제출: reviewSubmission 확보 → 해당 appStoreVersion 을 항목으로 추가 → submitted=true.
 * prepare 로 빌드가 연결돼 있어야 한다(연결 없으면 ASC 가 거부).
 */
export async function submitAppStoreForReview(opts: {
  bundleId: string;
  marketingVersion: string;
}): Promise<SubmitResult> {
  const appId = await findAppId(opts.bundleId);
  const version = await findOrCreateVersion(appId, opts.marketingVersion);
  if (!EDITABLE_STATES.has(version.appStoreState)) {
    throw new Error(
      `현재 상태(${version.appStoreState})에서는 심사 제출할 수 없습니다.`,
    );
  }

  const reviewSubmissionId = await findOrCreateReviewSubmission(appId);
  await addSubmissionItem(reviewSubmissionId, version.id);

  await asc(`/v1/reviewSubmissions/${reviewSubmissionId}`, {
    method: "PATCH",
    body: JSON.stringify({
      data: {
        type: "reviewSubmissions",
        id: reviewSubmissionId,
        attributes: { submitted: true },
      },
    }),
  });

  return { reviewSubmissionId, versionId: version.id, submitted: true };
}

/** 심사 생성(제출 아님): 버전 준비 → 열린 제출 확보 → 이 버전을 항목으로 추가. */
export async function createAppStoreReviewSubmission(opts: {
  bundleId: string;
  marketingVersion: string;
  notes: ReleaseNoteTranslationsInput;
}): Promise<{ prepare: PrepareResult; reviewSubmissionId?: string }> {
  const prepare = await prepareAppStoreSubmission(opts);
  // 빌드가 연결되지 않은 상태로 항목을 만들면 제출 단계에서 ASC 가 거부한다.
  if (!prepare.ready) return { prepare };

  const reviewSubmissionId = await findOrCreateReviewSubmission(prepare.appId);
  await addSubmissionItem(reviewSubmissionId, prepare.versionId);
  return { prepare, reviewSubmissionId };
}

/** 심사 생성 삭제: 아직 제출하지 않은 항목만 제거한다. */
export async function removeAppStoreReviewSubmissionItem(opts: {
  bundleId: string;
  marketingVersion: string;
}): Promise<{ removed: boolean }> {
  const status = await readAppStoreReviewStatus(opts);
  if (!status.submissionId || !status.submissionItemId) {
    throw new Error("삭제할 심사 항목이 없습니다.");
  }
  // 제출된 뒤에는 항목 제거가 아니라 제출 취소로만 회수할 수 있다.
  if (status.submissionState !== "READY_FOR_REVIEW") {
    throw new Error(
      `이미 제출된 심사(${status.submissionState})는 삭제할 수 없습니다. 제출 취소를 사용하세요.`,
    );
  }
  await asc(`/v1/reviewSubmissionItems/${status.submissionItemId}`, { method: "DELETE" });
  return { removed: true };
}

/** 제출 취소: 심사 대기·진행 중인 제출을 회수한다(canceled=true). */
export async function cancelAppStoreReviewSubmission(opts: {
  bundleId: string;
  marketingVersion: string;
}): Promise<{ reviewSubmissionId: string }> {
  const status = await readAppStoreReviewStatus(opts);
  if (!status.submissionId) throw new Error("취소할 심사 제출이 없습니다.");
  if (!CANCELABLE_SUBMISSION_STATES.has(status.submissionState ?? "")) {
    throw new Error(
      `현재 상태(${status.submissionState ?? "알 수 없음"})에서는 제출을 취소할 수 없습니다.`,
    );
  }
  await asc(`/v1/reviewSubmissions/${status.submissionId}`, {
    method: "PATCH",
    body: JSON.stringify({
      data: {
        type: "reviewSubmissions",
        id: status.submissionId,
        attributes: { canceled: true },
      },
    }),
  });
  return { reviewSubmissionId: status.submissionId };
}

export interface AppStoreReviewStatus {
  /** 마케팅 버전의 appStoreVersion. null=버전 아직 없음. */
  versionId: string | null;
  appStoreState: string | null;
  /** 메타데이터·빌드 편집이 가능한 상태인지. */
  versionEditable: boolean;
  /** 앱의 열린 심사 제출. null=열린 제출 없음. */
  submissionId: string | null;
  submissionState: string | null;
  /** 이 버전이 열린 제출에 포함돼 있으면 그 항목 id. */
  submissionItemId: string | null;
}

/**
 * 마케팅 버전의 현재 심사 단계 라이브 조회(버튼 구성·실행 가드 공용).
 * appStoreVersion 상태와 열린 reviewSubmission 을 함께 본다. 둘은 별개 리소스라
 * "버전은 편집 가능한데 제출은 진행 중" 같은 조합이 실제로 존재한다.
 */
export async function readAppStoreReviewStatus(opts: {
  bundleId: string;
  marketingVersion: string;
}): Promise<AppStoreReviewStatus> {
  const appId = await findAppId(opts.bundleId);
  const doc = await asc(
    `/v1/apps/${appId}/appStoreVersions?filter[platform]=${PLATFORM}` +
      `&filter[versionString]=${encodeURIComponent(opts.marketingVersion)}&limit=1`,
  );
  const ver = asArray(doc.data)[0];
  const versionId = ver?.id ?? null;
  const appStoreState = ver ? String(ver.attributes?.appStoreState ?? "") || null : null;

  const submission = await findOpenReviewSubmission(appId);
  const submissionItemId =
    submission && versionId ? await findSubmissionItem(submission.id, versionId) : null;

  return {
    versionId,
    appStoreState,
    versionEditable: EDITABLE_STATES.has(appStoreState ?? ""),
    submissionId: submission?.id ?? null,
    submissionState: submission?.state ?? null,
    submissionItemId,
  };
}
