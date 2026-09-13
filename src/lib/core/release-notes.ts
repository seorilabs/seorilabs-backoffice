import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { llmComplete, llmChatConfigured, llmChatModel } from "@/lib/ai/llm";
import {
  buildReleaseNotesI18nPrompt,
  parseReleaseNotesI18nOutput,
  RELEASE_NOTE_MARKET_KEYS,
  type ReleaseNoteMarketKey,
} from "@/lib/ai/agents";
import { normalizeStoreNotes } from "@/lib/core/store-notes";
import {
  RELEASE_NOTE_LOCALES,
  type ReleaseNoteTranslations,
} from "@/lib/core/release-note-locales";
import { HIDDEN_APP_ERROR, visibleAppWhere } from "@/lib/domain/app-visibility";
import {
  listVersionTags,
  previousTag,
  compareTags,
  type CompareResult,
} from "@/lib/github/release";
import type { ReleaseMarket } from "@prisma/client";

/**
 * LLM 응답 키(소문자 camelCase) → Prisma enum. 입력 검증 겸 매핑.
 */
const MARKET_KEY_TO_ENUM: Record<ReleaseNoteMarketKey, ReleaseMarket> = {
  googlePlay: "PLAY",
  appStore: "APPSTORE",
  ait: "AIT",
};

/**
 * 이 repo에서 "가장 최근에 출시노트가 생성된" 버전. v1.0.29 같은 snapshot/preview 태그가
 * 사이에 끼어도 v1.0.30의 diff는 v1.0.28을 baseline으로 잡힌다. 출시노트가 한 건도 없으면
 * 기존 semver 직전 태그로 폴백한다.
 */
async function lastReleasedTagWithNote(
  repoFullName: string,
  currentVersion: string,
): Promise<string | null> {
  const note = await prisma.releaseNote.findFirst({
    where: {
      repoFullName,
      NOT: { version: currentVersion },
    },
    orderBy: { createdAt: "desc" },
    select: { version: true },
  });
  return note?.version ?? null;
}

// 출시노트 생성 코어 — 릴리즈 태그 push(webhook) 또는 수동 백필 공용.
// 이전 릴리즈 태그~새 태그 diff → Gemini로 다국어 유저 공지 생성 → ReleaseNote 저장.

export interface GenerateReleaseNoteInput {
  repoFullName: string;
  version: string; // 새 태그
  headSha?: string;
}

export interface ReleaseNoteResult {
  /** 가장 최근에 upsert 된 row 의 id (마켓 식별 정보 없음). */
  id: string;
  version: string;
  previousVersion: string | null;
  /** 새로 작성(또는 갱신)된 마켓 row 의 id 목록. */
  marketIds: Array<{ market: ReleaseMarket; id: string }>;
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
  if (!llmChatConfigured()) {
    console.warn("[release-notes] 챗 LLM 미구성 — 생성 스킵");
    return null;
  }

  // 직전 출시노트가 있는 릴리즈 태그 + diff. snapshot/preview 등 사이에 끼는 태그는 건너뛴다.
  const [tags, lastNoteTag] = await Promise.all([
    listVersionTags(input.repoFullName),
    lastReleasedTagWithNote(input.repoFullName, input.version),
  ]);
  const prev = lastNoteTag ?? previousTag(tags, input.version);
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

  const raw = await llmComplete({
    system,
    prompt,
    maxTokens: 8000,
    jsonOutput: true,
    usage: { path: "release-notes" },
  });

  // 3 마켓 × 8 언어 구조를 안전 파싱. 파싱 실패 시 단일 row 로도 폴백하지 않고 null 반환 —
  // 마켓 분류 없이 모든 마켓이 같은 본문을 받는 회귀를 막는다.
  const parsed = parseReleaseNotesI18nOutput(raw);
  if (!parsed) {
    console.warn(`[release-notes] 마켓별 JSON 파싱 실패 — 생성 스킵`);
    return null;
  }

  // 마켓별로 노트를 upsert. 번역은 normalizeStoreNotes 로 정형화하고, 누락 언어는 fallback.
  const baseMeta = {
    appId: app.id,
    repoFullName: input.repoFullName,
    previousVersion: prev,
    headSha: input.headSha ?? null,
    compareUrl: cmp?.url ?? null,
    status: "GENERATED" as const,
    model: llmChatModel(),
  };
  const sourceJsonBase = {
    prs: cmp?.prs ?? [],
    commitCount: cmp?.commitCount ?? 0,
  };

  const marketIds: Array<{ market: ReleaseMarket; id: string }> = [];
  let lastId = "";
  for (const marketKey of RELEASE_NOTE_MARKET_KEYS) {
    const enumMarket = MARKET_KEY_TO_ENUM[marketKey];
    const section = parsed.byMarket[marketKey];
    const translations = Object.fromEntries(
      RELEASE_NOTE_LOCALES.map(({ field, promptKey, fallback }) => [
        field,
        normalizeStoreNotes((section[promptKey] ?? "").trim()) || fallback,
      ]),
    ) as ReleaseNoteTranslations;

    const row = await prisma.releaseNote.upsert({
      where: {
        repoFullName_version_market: {
          repoFullName: input.repoFullName,
          version: input.version,
          market: enumMarket,
        },
      },
      create: {
        version: input.version,
        market: enumMarket,
        ...baseMeta,
        ...translations,
        sourceJson: sourceJsonBase as object,
      },
      update: {
        ...baseMeta,
        ...translations,
        sourceJson: sourceJsonBase as object,
      },
    });
    lastId = row.id;
    marketIds.push({ market: enumMarket, id: row.id });
  }

  return { id: lastId, version: input.version, previousVersion: prev, marketIds };
}
