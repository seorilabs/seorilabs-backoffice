import { prisma } from "@/lib/prisma";
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
  compareTags,
  type CompareResult,
} from "@/lib/github/release";
import {
  RELEASE_NOTE_MARKETS,
  selectPreviousReleaseVersions,
  type ReleaseNoteMarket,
} from "@/lib/core/release-note-baseline";
import type { ReleaseMarket } from "@prisma/client";

/**
 * LLM 응답 키(소문자 camelCase) → Prisma enum. 입력 검증 겸 매핑.
 */
const MARKET_KEY_TO_ENUM: Record<ReleaseNoteMarketKey, ReleaseMarket> = {
  googlePlay: "PLAY",
  appStore: "APPSTORE",
  ait: "AIT",
};

const MARKET_ENUM_TO_KEY: Record<ReleaseNoteMarket, ReleaseNoteMarketKey> = {
  PLAY: "googlePlay",
  APPSTORE: "appStore",
  AIT: "ait",
};

async function lastSuccessfulReleaseByMarket(
  appId: string,
  currentVersion: string,
): Promise<Record<ReleaseNoteMarket, string | null>> {
  const releases = await prisma.releaseRecord.findMany({
    where: {
      appId,
      market: { in: [...RELEASE_NOTE_MARKETS] },
    },
    select: { market: true, version: true, status: true, deployedAt: true },
  });
  return selectPreviousReleaseVersions(
    releases.flatMap((release) =>
      release.market === "PLAY" || release.market === "APPSTORE" || release.market === "AIT"
        ? [{ ...release, market: release.market }]
        : [],
    ),
    currentVersion,
  );
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

  // 출시노트 생성 이력이 아니라 마켓별 마지막 성공 배포를 기준으로 각각 비교한다.
  const previousVersions = await lastSuccessfulReleaseByMarket(app.id, input.version);
  const marketChanges = Object.fromEntries(
    await Promise.all(
      RELEASE_NOTE_MARKETS.map(async (market) => {
        const marketKey = MARKET_ENUM_TO_KEY[market];
        const previousVersion = previousVersions[market];
        let compare: CompareResult | null = null;
        if (previousVersion) {
          try {
            compare = await compareTags(input.repoFullName, previousVersion, input.version);
          } catch (e) {
            console.warn(
              `[release-notes] ${market} compare 실패: ${(e as Error).message}`,
            );
          }
        }
        return [marketKey, { previousVersion, compare }] as const;
      }),
    ),
  ) as Record<
    ReleaseNoteMarketKey,
    { previousVersion: string | null; compare: CompareResult | null }
  >;

  const { system, prompt } = buildReleaseNotesI18nPrompt({
    displayName: app.displayName,
    type: app.type,
    version: input.version,
    byMarket: Object.fromEntries(
      RELEASE_NOTE_MARKET_KEYS.map((marketKey) => {
        const change = marketChanges[marketKey];
        return [
          marketKey,
          {
            previousVersion: change.previousVersion,
            prs: change.compare?.prs ?? [],
            commitCount: change.compare?.commitCount ?? 0,
          },
        ];
      }),
    ) as Parameters<typeof buildReleaseNotesI18nPrompt>[0]["byMarket"],
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
    headSha: input.headSha ?? null,
    status: "GENERATED" as const,
    model: llmChatModel(),
  };

  const marketIds: Array<{ market: ReleaseMarket; id: string }> = [];
  let lastId = "";
  for (const marketKey of RELEASE_NOTE_MARKET_KEYS) {
    const enumMarket = MARKET_KEY_TO_ENUM[marketKey];
    const change = marketChanges[marketKey];
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
        previousVersion: change.previousVersion,
        compareUrl: change.compare?.url ?? null,
        ...translations,
        sourceJson: {
          prs: change.compare?.prs ?? [],
          commitCount: change.compare?.commitCount ?? 0,
        },
      },
      update: {
        ...baseMeta,
        previousVersion: change.previousVersion,
        compareUrl: change.compare?.url ?? null,
        ...translations,
        sourceJson: {
          prs: change.compare?.prs ?? [],
          commitCount: change.compare?.commitCount ?? 0,
        },
      },
    });
    lastId = row.id;
    marketIds.push({ market: enumMarket, id: row.id });
  }

  return {
    id: lastId,
    version: input.version,
    previousVersion: previousVersions.PLAY,
    marketIds,
  };
}
