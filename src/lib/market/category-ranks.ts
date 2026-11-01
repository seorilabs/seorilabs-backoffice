import { marketLabel, type KeywordMarket } from "./keyword-cycle";

export interface AppleChartEntry {
  bundleId: string;
  trackId: string;
  title: string;
  categoryId: string;
  categoryName: string;
  rank: number;
}

export interface CategoryRankSummaryItem {
  appName: string;
  market: KeywordMarket | string;
  categoryName: string;
  rank: number | null;
  previousRank: number | null;
  change: string;
}

/**
 * Apple 공식 RSS 피드 JSON에서 순위별 앱 목록을 추출한다.
 * 엔드포인트: https://itunes.apple.com/{country}/rss/topfreeapplications/limit=100/genre={genreId}/json
 */
export function parseAppleCategoryChart(jsonText: string): AppleChartEntry[] {
  if (!jsonText || typeof jsonText !== "string") return [];
  let data: { feed?: { entry?: unknown } };
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const rawEntries = data?.feed?.entry;
  if (!rawEntries) return [];

  const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
  const results: AppleChartEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as {
      id?: { attributes?: { "im:bundleId"?: string; "im:id"?: string } };
      "im:name"?: { label?: string };
      category?: { attributes?: { "im:id"?: string; label?: string; term?: string } };
    };
    const bundleId = entry?.id?.attributes?.["im:bundleId"] ?? "";
    const trackId = entry?.id?.attributes?.["im:id"] ?? "";
    const title = entry?.["im:name"]?.label ?? "";
    const categoryId = entry?.category?.attributes?.["im:id"] ?? "";
    const categoryName = entry?.category?.attributes?.label ?? entry?.category?.attributes?.term ?? "";

    if (bundleId || trackId) {
      results.push({
        bundleId,
        trackId,
        title,
        categoryId,
        categoryName,
        rank: i + 1,
      });
    }
  }

  return results;
}

/**
 * Google Play 카테고리 페이지 HTML에서 고유 앱 패키지명 목록을 순서대로 추출한다.
 */
export function parsePlayCategoryChart(html: string): string[] {
  if (!html || typeof html !== "string") return [];
  if (/recaptcha|unusual traffic|consent.google.com\/m/i.test(html)) {
    throw new Error("PLAY_BLOCKED");
  }

  // 광고 블록 및 스크립트 제거
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  const packages: string[] = [];
  const linkRegex = /<a\b[^>]*href="\/store\/apps\/details\?id=([A-Za-z0-9_.]+)(?:[?&][^"<>]*)?"[^>]*>([\s\S]*?)<\/a>/g;

  for (const match of cleaned.matchAll(linkRegex)) {
    const pkg = match[1];
    const cardContent = match[0];
    if (/\bSponsored\b|\bAdvertisement\b|aria-label="Ad"|>Ad<|>광고</i.test(cardContent)) {
      continue;
    }
    if (pkg && !packages.includes(pkg)) {
      packages.push(pkg);
    }
  }

  // 링크 태그 외에 단순 details?id 매칭으로 보완 (클러스터 내 리스트아이템 기준)
  if (packages.length === 0) {
    const fallbackRegex = /\/store\/apps\/details\?id=([A-Za-z0-9_.]+)/g;
    for (const match of cleaned.matchAll(fallbackRegex)) {
      const pkg = match[1];
      if (pkg && !packages.includes(pkg)) {
        packages.push(pkg);
      }
    }
  }

  return packages;
}

/**
 * Google Play 앱 상세 HTML에서 카테고리 ID와 표시명을 추출한다.
 */
export function parsePlayAppCategory(html: string): { categoryId: string; categoryName: string } | null {
  if (!html || typeof html !== "string") return null;

  let categoryId = "";
  const catMatch = html.match(/"applicationCategory"\s*:\s*"([^"]+)"/);
  if (catMatch) {
    categoryId = catMatch[1];
  }

  let categoryName = "";
  if (categoryId) {
    const labelMatch = html.match(new RegExp(`href="\\/store\\/apps\\/category\\/${categoryId}"[^>]*aria-label="([^"]+)"`));
    if (labelMatch) {
      categoryName = labelMatch[1];
    } else {
      categoryName = categoryId.replace(/^GAME_/, "게임 > ").toLowerCase();
    }
  }

  if (!categoryId) return null;
  return { categoryId, categoryName: categoryName || categoryId };
}

/**
 * Apple Lookup 결과에서 주 카테고리 ID와 이름을 추출한다.
 */
export function parseAppleLookupCategory(app: {
  primaryGenreId?: number | string;
  primaryGenreName?: string;
  genreIds?: Array<number | string>;
  genres?: string[];
} | null | undefined): { categoryId: string; categoryName: string } | null {
  if (!app) return null;
  const categoryId = app.primaryGenreId ? String(app.primaryGenreId) : app.genreIds?.[0] ? String(app.genreIds[0]) : "";
  const categoryName = app.primaryGenreName ?? app.genres?.[0] ?? "";
  if (!categoryId) return null;
  return { categoryId, categoryName: categoryName || categoryId };
}

/**
 * 카테고리 순위 변동을 사람이 읽기 쉬운 문자열로 표현한다.
 */
export function describeCategoryRankChange(
  previous: number | null | undefined,
  current: number | null,
): string {
  if (previous === undefined) {
    return current === null ? "첫 관측 (순위권 밖)" : `첫 관측 (${current}위)`;
  }
  if (previous === null && current === null) {
    return "순위권 밖 유지";
  }
  if (previous === null && current !== null) {
    return `순위권 진입 (${current}위)`;
  }
  if (previous !== null && current === null) {
    return `순위권 이탈 (이전: ${previous}위)`;
  }
  if (previous === current) {
    return "변동 없음";
  }
  const diff = Math.abs(previous! - current!);
  if (current! < previous!) {
    return `${diff}계단 상승 (▲${diff})`;
  }
  return `${diff}계단 하락 (▼${diff})`;
}

/**
 * 슬랙 리포트용 카테고리 순위 요약 블록을 렌더링한다.
 */
export function formatCategoryRankSummary(items: CategoryRankSummaryItem[]): string {
  if (!items || items.length === 0) return "";

  const lines = items.map((item) => {
    const market = marketLabel(item.market);
    const rankStr = item.rank === null ? "순위권 밖" : `${item.rank}위`;
    const prevStr = item.previousRank !== null && item.previousRank !== undefined ? ` (이전: ${item.previousRank}위 · ${item.change})` : ` (${item.change})`;
    return `• **${item.appName.replace(/[@<>`]/g, "")}** · ${market} ${item.categoryName} ${rankStr}${prevStr}`;
  });

  return [
    "*카테고리 순위 관측*",
    ...lines,
    "",
  ].join("\n");
}
