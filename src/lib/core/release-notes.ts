import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { geminiComplete } from "@/lib/ai/gemini";
import { parseLooseJson } from "@/lib/ai/json";
import { buildReleaseNotesI18nPrompt } from "@/lib/ai/agents";
import { normalizeStoreNotes } from "@/lib/core/store-notes";
import {
  RELEASE_NOTE_LOCALES,
  type ReleaseNotePromptKey,
  type ReleaseNoteTranslations,
} from "@/lib/core/release-note-locales";
import { HIDDEN_APP_ERROR, visibleAppWhere } from "@/lib/domain/app-visibility";
import {
  listVersionTags,
  previousTag,
  compareTags,
  type CompareResult,
} from "@/lib/github/release";

// 출시노트 생성 코어 — 릴리즈 태그 push(webhook) 또는 수동 백필 공용.
// 이전 릴리즈 태그~새 태그 diff → Gemini로 다국어 유저 공지 생성 → ReleaseNote 저장.

export interface GenerateReleaseNoteInput {
  repoFullName: string;
  version: string; // 새 태그
  headSha?: string;
}

export interface ReleaseNoteResult {
  id: string;
  version: string;
  previousVersion: string | null;
}

export async function generateReleaseNoteCore(
  input: GenerateReleaseNoteInput,
): Promise<ReleaseNoteResult | null> {
  const app = await prisma.app.findUnique({
    where: { repoFullName: input.repoFullName },
    select: { id: true, displayName: true, type: true },
  });
  if (!app) {
    console.warn(`[release-notes] 미등록 repo: ${input.repoFullName}`);
    return null;
  }
  const visibleApp = await prisma.app.findFirst({
    where: { id: app.id, ...visibleAppWhere },
    select: { id: true },
  });
  if (!visibleApp) {
    console.warn(`[release-notes] ${HIDDEN_APP_ERROR}`);
    return null;
  }
  if (!env.geminiChatConfigured()) {
    console.warn("[release-notes] Gemini 미구성 — 생성 스킵");
    return null;
  }

  // 이전 릴리즈 태그 + diff.
  const tags = await listVersionTags(input.repoFullName);
  const prev = previousTag(tags, input.version);
  let cmp: CompareResult | null = null;
  if (prev) {
    try {
      cmp = await compareTags(input.repoFullName, prev, input.version);
    } catch (e) {
      console.warn(`[release-notes] compare 실패: ${(e as Error).message}`);
    }
  }

  const { system, prompt } = buildReleaseNotesI18nPrompt({
    displayName: app.displayName,
    type: app.type,
    version: input.version,
    previousVersion: prev,
    prs: cmp?.prs ?? [],
    commitCount: cmp?.commitCount ?? 0,
  });

  const raw = await geminiComplete({
    system,
    prompt,
    maxTokens: 4000,
    jsonOutput: true,
  });
  const parsed = parseLooseJson<Partial<Record<ReleaseNotePromptKey, string>>>(raw);
  // 순수 텍스트 불릿으로 정리하되 번역 원문은 자르지 않는다. 누락 언어만 현지어 폴백을 쓴다.
  // 파싱 실패 시 raw(JSON 원문) 전체를 특정 언어 노트로 흘리지 않는다.
  const translations = Object.fromEntries(
    RELEASE_NOTE_LOCALES.map(({ field, promptKey, fallback }) => [
      field,
      normalizeStoreNotes((parsed?.[promptKey] ?? "").trim()) || fallback,
    ]),
  ) as ReleaseNoteTranslations;

  const data = {
    appId: app.id,
    repoFullName: input.repoFullName,
    previousVersion: prev,
    headSha: input.headSha ?? null,
    compareUrl: cmp?.url ?? null,
    ...translations,
    sourceJson: {
      prs: cmp?.prs ?? [],
      commitCount: cmp?.commitCount ?? 0,
    } as object,
    status: "GENERATED" as const,
    model: env.geminiChatModel(),
  };

  const note = await prisma.releaseNote.upsert({
    where: {
      repoFullName_version: {
        repoFullName: input.repoFullName,
        version: input.version,
      },
    },
    create: { version: input.version, ...data },
    update: data,
  });

  return { id: note.id, version: input.version, previousVersion: prev };
}
