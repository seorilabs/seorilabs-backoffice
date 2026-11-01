import { prisma } from "@/lib/prisma";
import { metricDayOf, toDbDay } from "@/lib/analytics/metric-day";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { boundedText, createApplePublicClient } from "./public-sources";
import {
  parseAppleCategoryChart,
  parsePlayCategoryChart,
  parsePlayAppCategory,
  parseAppleLookupCategory,
  describeCategoryRankChange,
  type CategoryRankSummaryItem,
} from "./category-ranks";

export interface CategoryCollectorOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export async function collectCategoryRanks(
  now = new Date(),
  options: CategoryCollectorOptions = {},
): Promise<{ collectedCount: number; items: CategoryRankSummaryItem[] }> {
  const impl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const apps = await prisma.app.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      displayName: true,
      iosBundle: true,
      playPackage: true,
      configRevisions: {
        where: { status: "ACTIVE" },
        orderBy: { revision: "desc" },
        take: 1,
      },
    },
  });

  const day = toDbDay(metricDayOf(now));
  const apple = createApplePublicClient({ fetchImpl: impl, sleep });
  const items: CategoryRankSummaryItem[] = [];
  let collectedCount = 0;

  for (const app of apps) {
    const revision = app.configRevisions[0];
    const parsed = configRevisionPayloadSchema.safeParse(revision?.payload);
    const monitoring = parsed.success ? parsed.data.monitoring : undefined;
    const countries = monitoring?.countries && monitoring.countries.length > 0
      ? monitoring.countries
      : ["kr"];

    // 1. App Store 수집
    if (app.iosBundle) {
      for (const country of countries) {
        try {
          const lookupResults = await apple.lookup({ bundleId: app.iosBundle }, country);
          const targetLookup = lookupResults.find((r) => r.bundleId === app.iosBundle) ?? lookupResults[0];
          const catInfo = parseAppleLookupCategory(targetLookup);

          if (catInfo) {
            const feedUrl = `https://itunes.apple.com/${country}/rss/topfreeapplications/limit=100/genre=${catInfo.categoryId}/json`;
            const response = await impl(feedUrl, { signal: AbortSignal.timeout(15_000) });
            if (response.ok) {
              const text = await boundedText(response, 4 * 1024 * 1024);
              const chart = parseAppleCategoryChart(text);
              const targetTrackId = targetLookup ? String(targetLookup.trackId) : "";
              const found = chart.find((c) => (targetTrackId && c.trackId === targetTrackId) || (c.bundleId && c.bundleId === app.iosBundle));
              const rank = found ? found.rank : null;

              // 직전 관측 조회
              const target = `app-store:${catInfo.categoryId}`;
              const prevObs = await prisma.marketObservation.findFirst({
                where: {
                  appId: app.id,
                  kind: "category_rank",
                  target,
                  country,
                  day: { lt: day },
                },
                orderBy: { day: "desc" },
              });
              const prevValue = prevObs?.value as { rank?: number | null } | null;
              const previousRank = prevObs ? (prevValue?.rank ?? null) : undefined;
              const change = describeCategoryRankChange(previousRank, rank);

              const summaryItem: CategoryRankSummaryItem = {
                appName: app.displayName,
                market: "app-store",
                country,
                categoryName: catInfo.categoryName,
                rank,
                previousRank: previousRank ?? null,
                change,
              };
              items.push(summaryItem);

              await prisma.$transaction(async (tx) => {
                const key = {
                  appId: app.id,
                  kind: "category_rank",
                  target,
                  country,
                  day,
                };
                const val = {
                  rank,
                  categoryId: catInfo.categoryId,
                  categoryName: catInfo.categoryName,
                  market: "app-store",
                  previousRank: previousRank ?? null,
                  change,
                  appName: app.displayName,
                };
                await tx.marketObservation.createMany({
                  data: [{ ...key, value: val, sourceUrl: feedUrl, observedAt: now }],
                  skipDuplicates: true,
                });
                await tx.marketObservation.updateMany({
                  where: { ...key, observedAt: { lt: now } },
                  data: { value: val, sourceUrl: feedUrl, observedAt: now },
                });
              });

              collectedCount++;
            }
          }
        } catch {
          // 일시적 네트워크/파싱 오류는 건너뛰고 다음 수집 계속
        }
      }
    }

    // 2. Google Play 수집
    if (app.playPackage && process.env.KEYWORD_PLAY_ENABLED === "true") {
      for (const country of countries) {
        try {
          const detailUrl = `https://play.google.com/store/apps/details?id=${encodeURIComponent(app.playPackage)}&hl=ko&gl=${country.toUpperCase()}`;
          const detailRes = await impl(detailUrl, { signal: AbortSignal.timeout(15_000) });
          if (detailRes.ok) {
            const detailHtml = await boundedText(detailRes, 4 * 1024 * 1024);
            const catInfo = parsePlayAppCategory(detailHtml);

            if (catInfo) {
              await sleep(2000);
              const chartUrl = `https://play.google.com/store/apps/category/${encodeURIComponent(catInfo.categoryId)}?hl=ko&gl=${country.toUpperCase()}`;
              const chartRes = await impl(chartUrl, { signal: AbortSignal.timeout(15_000) });
              if (chartRes.ok) {
                const chartHtml = await boundedText(chartRes, 4 * 1024 * 1024);
                const packages = parsePlayCategoryChart(chartHtml);
                const index = packages.indexOf(app.playPackage);
                const rank = index >= 0 ? index + 1 : null;

                const target = `google-play:${catInfo.categoryId}`;
                const prevObs = await prisma.marketObservation.findFirst({
                  where: {
                    appId: app.id,
                    kind: "category_rank",
                    target,
                    country,
                    day: { lt: day },
                  },
                  orderBy: { day: "desc" },
                });
                const prevValue = prevObs?.value as { rank?: number | null } | null;
                const previousRank = prevObs ? (prevValue?.rank ?? null) : undefined;
                const change = describeCategoryRankChange(previousRank, rank);

                const summaryItem: CategoryRankSummaryItem = {
                  appName: app.displayName,
                  market: "google-play",
                  country,
                  categoryName: catInfo.categoryName,
                  rank,
                  previousRank: previousRank ?? null,
                  change,
                };
                items.push(summaryItem);

                await prisma.$transaction(async (tx) => {
                  const key = {
                    appId: app.id,
                    kind: "category_rank",
                    target,
                    country,
                    day,
                  };
                  const val = {
                    rank,
                    categoryId: catInfo.categoryId,
                    categoryName: catInfo.categoryName,
                    market: "google-play",
                    previousRank: previousRank ?? null,
                    change,
                    appName: app.displayName,
                  };
                  await tx.marketObservation.createMany({
                    data: [{ ...key, value: val, sourceUrl: chartUrl, observedAt: now }],
                    skipDuplicates: true,
                  });
                  await tx.marketObservation.updateMany({
                    where: { ...key, observedAt: { lt: now } },
                    data: { value: val, sourceUrl: chartUrl, observedAt: now },
                  });
                });

                collectedCount++;
              }
            }
          }
        } catch {
          // 일시적 네트워크/파싱 오류 건너뜀
        }
      }
    }
  }

  return { collectedCount, items };
}

/**
 * 특정 일자의 최신 카테고리 순위 관측 목록을 조회한다.
 */
export async function getLatestCategoryRankSummaries(
  now = new Date(),
): Promise<CategoryRankSummaryItem[]> {
  const day = toDbDay(metricDayOf(now));
  const observations = await prisma.marketObservation.findMany({
    where: {
      kind: "category_rank",
      day,
    },
    orderBy: { observedAt: "desc" },
  });

  const results: CategoryRankSummaryItem[] = [];
  const seen = new Set<string>();

  for (const obs of observations) {
    const key = `${obs.appId}:${obs.target}:${obs.country}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const val = obs.value as {
      rank?: number | null;
      previousRank?: number | null;
      categoryName?: string;
      market?: string;
      change?: string;
      appName?: string;
    } | null;

    if (val) {
      results.push({
        appName: val.appName ?? obs.appId,
        market: val.market ?? "app-store",
        country: obs.country,
        categoryName: val.categoryName ?? obs.target,
        rank: val.rank ?? null,
        previousRank: val.previousRank ?? null,
        change: val.change ?? "관측됨",
      });
    }
  }

  return results;
}
