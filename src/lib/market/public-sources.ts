import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

export const OFFICIAL_FEEDS = {
  "apple-news": {
    label: "Apple 개발자 소식",
    url: "https://developer.apple.com/news/rss/news.rss",
    host: "developer.apple.com",
  },
  "android-developers": {
    label: "Android 개발자 소식",
    url: "https://android-developers.googleblog.com/feeds/posts/default?alt=rss",
    host: "android-developers.googleblog.com",
  },
  "toss-developers": {
    label: "앱인토스 개발 공지",
    url: "https://techchat-apps-in-toss.toss.im/c/notice/9.rss",
    host: "techchat-apps-in-toss.toss.im",
  },
} as const;
const appSchema = z
  .object({
    trackId: z.number().int().positive(),
    bundleId: z.string().optional(),
    trackName: z.string().max(300),
    version: z.string().optional(),
    averageUserRating: z.number().min(0).max(5).optional(),
    userRatingCount: z.number().int().nonnegative().optional(),
    currentVersionReleaseDate: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();
export type PublicApp = z.infer<typeof appSchema>;
export function parseAppleApps(input: unknown): PublicApp[] {
  return z.object({ results: z.array(appSchema).max(200) }).parse(input).results;
}
export function keywordRank(results: Array<{ trackId: number }>, appId: number): number | null {
  const index = results.findIndex((result) => result.trackId === appId);
  return index < 0 ? null : index + 1;
}
export function significantRankChange(previous: number | null, current: number | null): boolean {
  return (
    previous !== current &&
    (previous === null || current === null || Math.abs(previous - current) >= 5)
  );
}
export async function boundedText(response: Response, maxBytes = 2 * 1024 * 1024): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error("SOURCE_RESPONSE_TOO_LARGE");
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts).toString("utf8");
}
export function createApplePublicClient(
  input: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
) {
  const impl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastRequest = 0;
  const request = async (url: URL, maxBytes = 2 * 1024 * 1024): Promise<PublicApp[]> => {
    for (let attempt = 0; ; attempt++) {
      await sleep(Math.max(0, 3500 - (Date.now() - lastRequest)));
      lastRequest = Date.now();
      let response: Response;
      try {
        response = await impl(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
      } catch {
        if (attempt >= 3) throw new Error("Apple Search timeout or network failure");
        await sleep([5000, 15000, 45000][attempt]);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
          await sleep([5000, 15000, 45000][attempt]);
          continue;
        }
        throw new Error(`Apple Search HTTP ${response.status}`);
      }
      return parseAppleApps(JSON.parse(await boundedText(response, maxBytes)));
    }
  };
  return {
    lookup: (identity: { bundleId: string } | { id: string }, country: string) => {
      const url = new URL("https://itunes.apple.com/lookup");
      url.searchParams.set("country", country);
      url.searchParams.set("entity", "software");
      for (const [key, value] of Object.entries(identity)) url.searchParams.set(key, value);
      return request(url);
    },
    search: (term: string, country: string) => {
      const url = new URL("https://itunes.apple.com/search");
      for (const [key, value] of Object.entries({
        term,
        country,
        entity: "software",
        limit: "200",
      }))
        url.searchParams.set(key, value);
      // 검색 200개에는 앱 설명·이미지 URL도 포함되어 정상 응답이 2MiB를 넘는다.
      return request(url, 8 * 1024 * 1024);
    },
  };
}
export interface OfficialArticle {
  title: string;
  url: string;
  publishedAt: Date;
}
export function parseOfficialFeed(
  text: string,
  feed: keyof typeof OFFICIAL_FEEDS,
): OfficialArticle[] {
  if (text.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text))
    throw new Error("SOURCE_FEED_INVALID");
  const parsed = new XMLParser({ processEntities: false, ignoreAttributes: false }).parse(text) as {
    rss?: { channel?: { item?: unknown } };
  };
  const items = parsed.rss?.channel?.item;
  if (!items) throw new Error("SOURCE_FEED_INVALID");
  return (Array.isArray(items) ? items : [items]).slice(0, 30).flatMap((item) => {
    const row = item as { title?: unknown; link?: unknown; pubDate?: unknown };
    if (
      typeof row.title !== "string" ||
      typeof row.link !== "string" ||
      typeof row.pubDate !== "string"
    )
      return [];
    let url: URL;
    try {
      url = new URL(row.link);
    } catch {
      return [];
    }
    const publishedAt = new Date(row.pubDate);
    if (
      url.protocol !== "https:" ||
      url.hostname !== OFFICIAL_FEEDS[feed].host ||
      Number.isNaN(publishedAt.getTime())
    )
      return [];
    return [{ title: row.title.replace(/<[^>]*>/g, "").slice(0, 160), url: url.href, publishedAt }];
  });
}
