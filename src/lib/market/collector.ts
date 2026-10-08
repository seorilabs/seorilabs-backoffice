import { boundedEvidenceLabel } from "@/lib/insights/contract";
import { publicLinkTarget } from "./support-links";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { metricDayOf, toDbDay } from "@/lib/analytics/metric-day";
import { observedCollection } from "@/lib/insights/collection";
import { publishSignal } from "@/lib/insights/service";
import {
  createApplePublicClient,
  keywordRank,
  significantRankChange,
  OFFICIAL_FEEDS,
  parseOfficialFeed,
  boundedText,
  type PublicApp,
} from "./public-sources";

const json = (value: unknown) => value as Prisma.InputJsonValue;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export async function collectMarketFeedback(now = new Date()) {
  const day = toDbDay(metricDayOf(now));
  const apps = await prisma.app.findMany({
    where: { status: { not: "DEPRECATED" } },
    select: {
      id: true,
      displayName: true,
      iosBundle: true,
      configRevisions: { where: { status: "ACTIVE" }, orderBy: { revision: "desc" }, take: 1 },
    },
  });
  const client = createApplePublicClient();
  const configuredFeeds = new Map<keyof typeof OFFICIAL_FEEDS, string[]>();
  let failed = 0,
    collected = 0;
  async function save(input: {
    appId: string;
    kind: string;
    target: string;
    country: string;
    value: object;
    sourceUrl: string;
  }) {
    const previous = await prisma.marketObservation.findFirst({
      where: {
        appId: input.appId,
        kind: input.kind,
        target: input.target,
        country: input.country,
        day: { lt: day },
      },
      orderBy: { day: "desc" },
    });
    await prisma.marketObservation.upsert({
      where: {
        appId_kind_target_country_day: {
          appId: input.appId,
          kind: input.kind,
          target: input.target,
          country: input.country,
          day,
        },
      },
      create: { ...input, value: json(input.value), day, observedAt: now },
      update: { value: json(input.value), observedAt: now },
    });
    collected++;
    return previous;
  }
  for (const app of apps) {
    const parsed = configRevisionPayloadSchema.safeParse(app.configRevisions[0]?.payload);
    const config = parsed.success ? parsed.data.monitoring : undefined;
    if (!parsed.success || !config?.enabled) continue;
    for (const feed of config.officialFeeds)
      configuredFeeds.set(feed, [...(configuredFeeds.get(feed) ?? []), app.id]);

    if (config.checkSupportLinks) {
      const links = [parsed.data.support?.supportUrl, parsed.data.support?.privacyPolicyUrl].filter(
        (url): url is string => Boolean(url),
      );
      for (const url of links)
        try {
          await observedCollection(
            { source: "support-link", target: publicLinkTarget(url), appId: app.id },
            async () => {
              const { checkPublicLink } = await import("./support-links");
              const status = await checkPublicLink(url);
              await save({
                appId: app.id,
                kind: "support-link",
                target: publicLinkTarget(url),
                country: "global",
                value: { status },
                sourceUrl: url,
              });
              if (status >= 400)
                await publishSignal({
                  dedupeKey:
                    "support:" + app.id + ":" + digest(url).slice(0, 24) + ":" + metricDayOf(now),
                  appId: app.id,
                  kind: "support-failure",
                  severity: "critical",
                  title: app.displayName + " 지원 링크 확인 필요",
                  observedAt: now,
                  facts: [
                    {
                      id: "status",
                      label: "HTTP 응답",
                      value: String(status),
                      source: url.slice(0, 200),
                    },
                  ],
                  sourceRefs: [{ label: "지원 링크", url }],
                });
              return { value: null, count: 1 };
            },
          );
        } catch {
          failed++;
        }
    }
    for (const country of config.countries) {
      let own: PublicApp | undefined;
      try {
        if (app.iosBundle)
          own = await observedCollection(
            { source: "apple-public-lookup", target: `${app.iosBundle}:${country}`, appId: app.id },
            async () => {
              const results = await client.lookup({ bundleId: app.iosBundle! }, country);
              return {
                value: results.find((result) => result.bundleId === app.iosBundle),
                count: results.length,
              };
            },
          );
        if (own) {
          // 해당 국가 리스팅 없음은 검색 순위 권외와 다르다.
          const sourceUrl = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(app.iosBundle!)}&country=${country}`;
          const previousRating = await save({
            appId: app.id,
            kind: "rating",
            target: app.iosBundle!,
            country,
            value: {
              trackId: own.trackId,
              ratingCount: own.userRatingCount ?? null,
              averageRating: own.averageUserRating ?? null,
              version: own.version ?? null,
            },
            sourceUrl,
          });
          const previous = previousRating?.value as
            { ratingCount?: number | null; averageRating?: number | null } | undefined;
          if (
            previous &&
            ((previous.ratingCount !== null &&
              previous.ratingCount !== undefined &&
              own.userRatingCount !== undefined &&
              Math.abs(own.userRatingCount - previous.ratingCount) >= 10) ||
              (previous.averageRating !== null &&
                previous.averageRating !== undefined &&
                own.averageUserRating !== undefined &&
                Math.abs(own.averageUserRating - previous.averageRating) >= 0.1))
          )
            await publishSignal({
              dedupeKey: "rating:" + app.id + ":" + country + ":" + metricDayOf(now),
              appId: app.id,
              kind: "review-rating-change",
              title: app.displayName + " 공개 평점 변화",
              observedAt: now,
              facts: [
                {
                  id: "rating",
                  label: country.toUpperCase() + " 공개 평점",
                  value: `${previous.averageRating ?? "미상"} → ${own.averageUserRating ?? "미상"}점 · 평점 수 ${previous.ratingCount ?? "미상"} → ${own.userRatingCount ?? "미상"}`,
                  source: "Apple lookup · 전체 평점 수와 수집된 리뷰 개수는 다름",
                },
              ],
              sourceRefs: [{ label: "공개 평점 원본", url: sourceUrl }],
            });
          if (own.version)
            await publishSignal({
              dedupeKey:
                "public-listing:" + app.id + ":" + country + ":" + own.trackId + ":" + own.version,
              appId: app.id,
              kind: "public-listing-confirmed",
              title: app.displayName + " 공개 리스팅 확인",
              observedAt: now,
              facts: [
                {
                  id: "listing",
                  label: country.toUpperCase() + " 공개 버전",
                  value: own.version.slice(0, 100),
                  source: "Apple lookup · bundle 및 국가 일치 · 최초 관측 시각과 출시일은 다름",
                },
              ],
              sourceRefs: [{ label: "공개 리스팅 원본", url: sourceUrl }],
            });
        }
      } catch {
        failed++;
      }
      for (const term of own ? config.keywords : []) {
        try {
          await observedCollection(
            { source: "apple-keyword", target: `${country}:${term}`, appId: app.id },
            async () => {
              const results = await client.search(term, country);
              const rank = keywordRank(results, own!.trackId);
              const sourceUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${country}&entity=software&limit=200`;
              const previous = await save({
                appId: app.id,
                kind: "keyword",
                target: term,
                country,
                value: { rank, resultCount: results.length, trackId: own!.trackId },
                sourceUrl,
              });
              const before = previous?.value as { rank?: number | null } | undefined;
              if (before && significantRankChange(before.rank ?? null, rank))
                await publishSignal({
                  dedupeKey: `keyword:${app.id}:${metricDayOf(now)}:${digest(`${country}:${term}`).slice(0, 24)}`,
                  appId: app.id,
                  kind: "keyword-change",
                  title: `${app.displayName} 검색 노출 변화`,
                  observedAt: now,
                  facts: [
                    {
                      id: "rank",
                      label: boundedEvidenceLabel(`${country.toUpperCase()} ${term}`),
                      value: `${before.rank ?? "200위 밖"} → ${rank ?? "200위 밖"}`,
                      source: "Apple Search API 관측 순서 - 기기 순위와 다를 수 있음",
                    },
                  ],
                  sourceRefs: [{ label: "검색 관측", url: sourceUrl }],
                });
              return { value: null, count: results.length };
            },
          );
        } catch {
          failed++;
        }
      }
      for (const id of config.competitorAppIds) {
        try {
          await observedCollection(
            { source: "apple-competitor", target: `${id}:${country}`, appId: app.id },
            async () => {
              const results = await client.lookup({ id }, country);
              const other = results.find((result) => String(result.trackId) === id);
              if (!other) return { value: null, count: 0 };
              const sourceUrl = `https://itunes.apple.com/lookup?id=${id}&country=${country}`;
              const descriptionHash = digest(other.description ?? "");
              const previous = await save({
                appId: app.id,
                kind: "competitor",
                target: id,
                country,
                value: {
                  name: other.trackName,
                  version: other.version ?? null,
                  ratingCount: other.userRatingCount ?? null,
                  averageRating: other.averageUserRating ?? null,
                  descriptionHash,
                  descriptionExcerpt: (other.description ?? "").slice(0, 400),
                },
                sourceUrl,
              });
              const before = previous?.value as
                { version?: string; descriptionHash?: string } | undefined;
              if (
                before &&
                (before.version !== other.version || before.descriptionHash !== descriptionHash)
              )
                await publishSignal({
                  dedupeKey: `competitor:${app.id}:${id}:${country}:${metricDayOf(now)}`,
                  appId: app.id,
                  kind: "competitor-update",
                  title: `${other.trackName.slice(0, 120)} 업데이트`,
                  observedAt: now,
                  facts: [
                    {
                      id: "version",
                      label: "공개 버전",
                      value: `${before.version ?? "미상"} → ${other.version ?? "미상"}`,
                      source: `Apple lookup ${country}`,
                    },
                  ],
                  sourceRefs: [{ label: "경쟁 앱 공개 정보", url: sourceUrl }],
                });
              return { value: null, count: 1 };
            },
          );
        } catch {
          failed++;
        }
      }
    }
  }
  for (const [feed, appIds] of configuredFeeds) {
    try {
      const source = OFFICIAL_FEEDS[feed];
      await observedCollection({ source: "official-policy-feed", target: feed }, async () => {
        const response = await fetch(source.url, {
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`Official feed HTTP ${response.status}`);
        const articles = parseOfficialFeed(await boundedText(response), feed).filter(
          (article) =>
            article.publishedAt <= now &&
            now.getTime() - article.publishedAt.getTime() < 7 * 86400000,
        );
        for (const article of articles)
          for (const appId of appIds)
            await publishSignal({
              dedupeKey: `policy:${appId}:${digest(article.url).slice(0, 40)}`,
              appId,
              kind: "policy-update",
              title: `${source.label}: ${article.title}`.slice(0, 180),
              observedAt: article.publishedAt,
              facts: [
                {
                  id: "announcement",
                  label: "공식 공지",
                  value: article.title.slice(0, 150),
                  source: source.label,
                },
              ],
              sourceRefs: [{ label: "원문", url: article.url }],
            });
        return { value: null, count: articles.length };
      });
    } catch {
      failed++;
    }
  }
  return { collected, failed };
}
