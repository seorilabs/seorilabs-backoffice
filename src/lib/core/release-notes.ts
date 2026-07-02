import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { miniMaxComplete } from "@/lib/ai/minimax";
import { parseLooseJson } from "@/lib/ai/json";
import { buildReleaseNotesI18nPrompt } from "@/lib/ai/agents";
import { normalizeStoreNotes } from "@/lib/core/store-notes";
import {
  listVersionTags,
  previousTag,
  compareTags,
  type CompareResult,
} from "@/lib/github/release";

// 출시노트 생성 코어 — 릴리즈 태그 push(webhook) 또는 수동 백필 공용.
// 이전 릴리즈 태그~새 태그 diff → MiniMax 로 ko/en 유저 공지 생성 → ReleaseNote 저장.

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
  if (!env.minimaxConfigured()) {
    console.warn("[release-notes] MiniMax 미구성 — 생성 스킵");
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

  const raw = await miniMaxComplete({
    system,
    prompt,
    temperature: 0.3,
    maxTokens: 1500,
    jsonOutput: true,
  });
  const parsed = parseLooseJson<{ ko_KR?: string; en_US?: string }>(raw);
  // 스토어 정형 포맷으로 강제(≤4불릿·각≤100자·언어당≤480자·순수텍스트). LLM 출력은 신뢰하지 않는다.
  // ko_KR 파싱 실패 시 raw(JSON 원문) 전체를 한국어 노트로 흘리지 않는다.
  const koKR =
    normalizeStoreNotes((parsed?.ko_KR ?? "").trim()) ||
    "- 버그 수정 및 안정성 개선";
  const enUS =
    normalizeStoreNotes((parsed?.en_US ?? "").trim()) || "- Bug fixes and stability improvements";

  const data = {
    appId: app.id,
    repoFullName: input.repoFullName,
    previousVersion: prev,
    headSha: input.headSha ?? null,
    compareUrl: cmp?.url ?? null,
    koKR,
    enUS,
    sourceJson: {
      prs: cmp?.prs ?? [],
      commitCount: cmp?.commitCount ?? 0,
    } as object,
    status: "GENERATED" as const,
    model: env.minimaxModel(),
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
