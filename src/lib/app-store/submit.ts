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

/** 앱의 열린 reviewSubmission(미제출) 조회, 없으면 생성. */
async function findOrCreateReviewSubmission(appId: string): Promise<string> {
  const open = await asc(
    `/v1/reviewSubmissions?filter[app]=${appId}` +
      `&filter[state]=READY_FOR_REVIEW,UNRESOLVED_ISSUES,COMPLETING&limit=1`,
  ).catch(() => null);
  const existing = open ? asArray(open.data)[0] : null;
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

  // 동일 버전이 이미 항목으로 있으면 중복 추가는 ASC 가 거부하므로 무시.
  await asc("/v1/reviewSubmissionItems", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: {
            data: { type: "reviewSubmissions", id: reviewSubmissionId },
          },
          appStoreVersion: { data: { type: "appStoreVersions", id: version.id } },
        },
      },
    }),
  }).catch((e) => {
    if (!/already|exist|duplicate/i.test((e as Error).message)) throw e;
  });

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

/** 마케팅 버전의 현재 appStoreState 라이브 조회(버튼 상태 표시용). null=버전 없음. */
export async function getAppStoreSubmissionState(opts: {
  bundleId: string;
  marketingVersion: string;
}): Promise<string | null> {
  const appId = await findAppId(opts.bundleId);
  const doc = await asc(
    `/v1/apps/${appId}/appStoreVersions?filter[platform]=${PLATFORM}` +
      `&filter[versionString]=${encodeURIComponent(opts.marketingVersion)}&limit=1`,
  );
  const ver = asArray(doc.data)[0];
  return ver ? String(ver.attributes?.appStoreState ?? "") || null : null;
}
