"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { listVersionTags } from "@/lib/github/release";
import { HIDDEN_APP_ERROR, isDisabledAppStatus } from "@/lib/domain/app-visibility";
import {
  createReleaseTagWithNotes,
  dispatchMarketDeploy,
  promoteGooglePlay,
  prepareAppStore,
  submitAppStore,
  type Bump,
  type DeployTarget,
} from "@/lib/core/release-ops";

// 릴리즈/배포 서버 액션 — 앱 상세 UI 에서 호출. 인증 + 입력 검증 후 GitHub write.
// (GitHub App 권한 필요: contents:write, actions:write. 미부여 시 런타임 오류를 error 로 반환.)

const BUMPS = new Set(["patch", "minor", "major"]);
const TARGETS = new Set(["AIT", "PLAY", "APPSTORE", "ALL"]);
const TAG_RE = /^v\d+\.\d+\.\d+$/;

async function repoOf(appId: string): Promise<string> {
  const app = await prisma.app.findUnique({
    where: { id: appId },
    select: { repoFullName: true, status: true },
  });
  if (!app) throw new Error("앱을 찾을 수 없습니다.");
  if (isDisabledAppStatus(app.status)) throw new Error(HIDDEN_APP_ERROR);
  return app.repoFullName;
}

export async function createReleaseAction(
  appId: string,
  bump: string,
): Promise<{ ok: boolean; tag?: string; url?: string; error?: string }> {
  const session = await requireSession();
  if (!BUMPS.has(bump)) return { ok: false, error: "잘못된 증가 단위" };
  try {
    const repoFullName = await repoOf(appId);
    const r = await createReleaseTagWithNotes({
      repoFullName,
      bump: bump as Bump,
      actorLabel: `web:${session.user.login ?? "?"}`,
    });
    revalidatePath(`/apps/${appId}`);
    revalidatePath("/releases");
    revalidatePath("/release-notes");
    return { ok: true, tag: r.tag, url: r.releaseUrl };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function listAppTagsAction(appId: string): Promise<{ tags: string[] }> {
  await requireSession();
  try {
    const repoFullName = await repoOf(appId);
    const tags = await listVersionTags(repoFullName);
    return { tags: tags.slice(0, 20).map((t) => t.name) };
  } catch {
    return { tags: [] };
  }
}

export async function deployAction(
  appId: string,
  tag: string,
  target: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await requireSession();
  if (!TAG_RE.test(tag)) return { ok: false, error: "잘못된 태그(vX.Y.Z)" };
  if (!TARGETS.has(target)) return { ok: false, error: "잘못된 배포 대상" };
  try {
    const repoFullName = await repoOf(appId);
    await dispatchMarketDeploy({
      repoFullName,
      target: target as DeployTarget,
      tag,
      actorLabel: `web:${session.user.login ?? "?"}`,
    });
    revalidatePath(`/apps/${appId}`);
    revalidatePath("/releases");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Google Play: 내부 빌드를 프로덕션으로 승격(재빌드 없이 심사 제출). */
export async function promoteToProductionAction(
  appId: string,
  tag: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await requireSession();
  if (!TAG_RE.test(tag)) return { ok: false, error: "잘못된 태그(vX.Y.Z)" };
  try {
    const repoFullName = await repoOf(appId);
    await promoteGooglePlay({
      repoFullName,
      tag,
      actorLabel: `web:${session.user.login ?? "?"}`,
    });
    revalidatePath(`/apps/${appId}`);
    revalidatePath("/releases");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** App Store 심사 준비(버전+언어별 what's new+빌드 연결). ready=false 면 빌드 처리 대기. */
export async function prepareAppStoreAction(
  appId: string,
  tag: string,
): Promise<{ ok: boolean; ready?: boolean; reason?: string; error?: string }> {
  const session = await requireSession();
  if (!TAG_RE.test(tag)) return { ok: false, error: "잘못된 태그(vX.Y.Z)" };
  try {
    const repoFullName = await repoOf(appId);
    const r = await prepareAppStore({
      repoFullName,
      tag,
      actorLabel: `web:${session.user.login ?? "?"}`,
    });
    revalidatePath(`/apps/${appId}`);
    return { ok: true, ready: r.ready, reason: r.reason };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** App Store 심사 제출(되돌리기 어려움 — UI 에서 명시 확인 후 호출). */
export async function submitAppStoreAction(
  appId: string,
  tag: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await requireSession();
  if (!TAG_RE.test(tag)) return { ok: false, error: "잘못된 태그(vX.Y.Z)" };
  try {
    const repoFullName = await repoOf(appId);
    await submitAppStore({
      repoFullName,
      tag,
      actorLabel: `web:${session.user.login ?? "?"}`,
    });
    revalidatePath(`/apps/${appId}`);
    revalidatePath("/releases");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
