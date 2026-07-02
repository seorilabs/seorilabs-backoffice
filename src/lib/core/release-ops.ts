import { prisma } from "@/lib/prisma";
import {
  createTag,
  createOrUpdateRelease,
  upsertReleaseAsset,
  dispatchWorkflow,
  resolveRefSha,
} from "@/lib/github/write";
import { listVersionTags } from "@/lib/github/release";
import { generateReleaseNoteCore } from "@/lib/core/release-notes";
import {
  buildReleaseNotesAsset,
  RELEASE_NOTES_ASSET_NAME,
} from "@/lib/core/store-notes";

// 릴리즈/배포 오케스트레이션 코어 — Backoffice UI / Telegram 공용.
// 원칙: GitHub write(태그/Release/dispatch) 후 결과는 webhook 으로 미러에 재수렴.
// 배포 dispatch 는 ReleaseRecord 를 직접 INSERT 하지 않는다(workflow_run 미러가 담당).

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export type Bump = "major" | "minor" | "patch";

function normalizeTag(raw: string): string {
  const v = raw.replace(/^v/i, "").trim();
  if (!SEMVER_RE.test(v)) throw new Error(`SemVer(vX.Y.Z) 형식이 아닙니다: ${raw}`);
  return `v${v}`;
}

export function bumpFrom(latest: string | null, bump: Bump): string {
  const base = (latest ?? "v0.0.0").replace(/^v/i, "");
  const [ma, mi, pa] = base.split(".").map((n) => parseInt(n, 10) || 0);
  if (bump === "major") return `v${ma + 1}.0.0`;
  if (bump === "minor") return `v${ma}.${mi + 1}.0`;
  return `v${ma}.${mi}.${pa + 1}`;
}

/** 다음 릴리즈 태그 계산(dispatch 전 미리보기용). */
export async function previewNextTag(
  repoFullName: string,
  bump: Bump,
): Promise<{ latest: string | null; next: string }> {
  const tags = await listVersionTags(repoFullName);
  const latest = tags[0]?.name ?? null;
  return { latest, next: bumpFrom(latest, bump) };
}

export interface CreateReleaseResult {
  tag: string;
  sha: string;
  created: boolean;
  releaseUrl: string;
  koKR: string;
  enUS: string;
  compareUrl: string | null;
}

/**
 * 명시적 릴리즈 태그 생성 → 출시노트(ko/en) 생성 → GitHub Release 발행.
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
  const sha = await resolveRefSha(opts.repoFullName, targetRef);

  let tag: string;
  if (opts.tag) {
    tag = normalizeTag(opts.tag);
  } else {
    const tags = await listVersionTags(opts.repoFullName);
    tag = bumpFrom(tags[0]?.name ?? null, opts.bump ?? "patch");
  }

  const { created } = await createTag({ repoFullName: opts.repoFullName, tag, sha });

  // 출시노트 동기 생성(마켓 무관 ko/en). 실패해도 Release 는 발행.
  let koKR = "";
  let enUS = "";
  let compareUrl: string | null = null;
  try {
    const note = await generateReleaseNoteCore({
      repoFullName: opts.repoFullName,
      version: tag,
      headSha: sha,
    });
    if (note) {
      const row = await prisma.releaseNote.findUnique({
        where: { repoFullName_version: { repoFullName: opts.repoFullName, version: tag } },
        select: { koKR: true, enUS: true, compareUrl: true },
      });
      koKR = row?.koKR ?? "";
      enUS = row?.enUS ?? "";
      compareUrl = row?.compareUrl ?? null;
    }
  } catch (e) {
    console.warn(`[release-ops] 출시노트 생성 실패: ${(e as Error).message}`);
  }

  const body = formatReleaseBody({ tag, koKR, enUS, compareUrl });
  const rel = await createOrUpdateRelease({
    repoFullName: opts.repoFullName,
    tag,
    name: tag,
    body,
    prerelease: opts.prerelease,
  });

  // 마켓 배포 워크플로우가 다운로드할 정형 출시노트 에셋(release-notes.json).
  // 실패해도 Release 는 유지(워크플로우는 에셋 없으면 config 기본값으로 폴백).
  try {
    const asset = buildReleaseNotesAsset({ tag, koKR, enUS });
    if (asset) {
      await upsertReleaseAsset({
        repoFullName: opts.repoFullName,
        releaseId: rel.id,
        name: RELEASE_NOTES_ASSET_NAME,
        contentType: "application/json",
        data: asset,
      });
    }
  } catch (e) {
    console.warn(`[release-ops] ${RELEASE_NOTES_ASSET_NAME} 업로드 실패: ${(e as Error).message}`);
  }

  await prisma.auditLog
    .create({
      data: {
        actorLogin: opts.actorLabel ?? null,
        action: "release.tag.create",
        entityType: "release",
        entityId: `${opts.repoFullName}@${tag}`,
        payload: { tag, sha, created, releaseUrl: rel.url } as object,
      },
    })
    .catch(() => {});

  return { tag, sha, created, releaseUrl: rel.url, koKR, enUS, compareUrl };
}

/** GitHub Release 본문(마켓 무관 ko/en + compare 링크). */
export function formatReleaseBody(n: {
  tag: string;
  koKR: string;
  enUS: string;
  compareUrl?: string | null;
}): string {
  const parts: string[] = [];
  if (n.koKR.trim()) parts.push(`## 🇰🇷 이번 업데이트\n\n${n.koKR.trim()}`);
  if (n.enUS.trim()) parts.push(`## 🇺🇸 What's New\n\n${n.enUS.trim()}`);
  if (parts.length === 0) parts.push(`Release ${n.tag}`);
  if (n.compareUrl) parts.push(`---\n\n**Changes:** ${n.compareUrl}`);
  return parts.join("\n\n");
}

// 배포 대상 → 표준 caller 워크플로우 파일.
export type DeployTarget = "AIT" | "PLAY" | "APPSTORE" | "ALL";

const MARKET_WORKFLOW: Record<DeployTarget, string> = {
  AIT: "deploy-apps-in-toss.yml",
  PLAY: "deploy-google-play.yml",
  APPSTORE: "deploy-app-store.yml",
  ALL: "deploy-all.yml",
};

export const DEPLOY_TARGET_KO: Record<DeployTarget, string> = {
  AIT: "AppsInToss",
  PLAY: "Google Play",
  APPSTORE: "App Store",
  ALL: "전체(Deploy All)",
};

// App.marketTargets(Json) → 배포 대상 후보.
export function deployTargetsFor(marketTargets: unknown): DeployTarget[] {
  const arr = Array.isArray(marketTargets) ? (marketTargets as string[]) : [];
  const out: DeployTarget[] = [];
  if (arr.includes("ait")) out.push("AIT");
  if (arr.includes("play")) out.push("PLAY");
  if (arr.includes("appstore")) out.push("APPSTORE");
  if (out.length > 1) out.push("ALL");
  return out;
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
}): Promise<{ workflowFile: string }> {
  const workflowFile = MARKET_WORKFLOW[opts.target];
  if (!workflowFile) throw new Error(`알 수 없는 배포 대상: ${opts.target}`);

  // 표준 caller 는 release_tag 입력을 받는다. AIT/ALL 은 memo 도 지원.
  const inputs: Record<string, string> = { release_tag: opts.tag };
  if ((opts.target === "AIT" || opts.target === "ALL") && opts.memo) {
    inputs.memo = opts.memo;
  }

  await dispatchWorkflow({
    repoFullName: opts.repoFullName,
    workflowFile,
    ref: opts.tag,
    inputs,
  });

  await prisma.auditLog
    .create({
      data: {
        actorLogin: opts.actorLabel ?? null,
        action: "release.deploy.dispatch",
        entityType: "release",
        entityId: `${opts.repoFullName}@${opts.tag}`,
        payload: { target: opts.target, workflowFile, tag: opts.tag } as object,
      },
    })
    .catch(() => {});

  return { workflowFile };
}
