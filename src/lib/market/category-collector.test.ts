import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectCategoryRanks,
  getLatestCategoryRankSummaries,
} from "./category-collector";
import { prisma } from "@/lib/prisma";

describe("category-collector", () => {
  it("앱이 없거나 비활성 상태이면 0건을 수집하고 정상 종료한다", async () => {
    const prismaApp = prisma.app as unknown as { findMany: unknown };
    const originalFindMany = prismaApp.findMany;
    prismaApp.findMany = async () => [];

    try {
      const result = await collectCategoryRanks(new Date());
      assert.equal(result.collectedCount, 0);
      assert.deepEqual(result.items, []);
    } finally {
      prismaApp.findMany = originalFindMany;
    }
  });

  it("App Store와 Google Play의 응답을 Mock하여 순위를 수집하고 요약 항목을 생성한다", async () => {
    const dummyApp = {
      id: "test-app-id",
      displayName: "테스트 앱",
      iosBundle: "com.test.app",
      playPackage: "com.test.app",
      configRevisions: [],
    };

    const prismaApp = prisma.app as unknown as { findMany: unknown };
    const prismaObs = prisma.marketObservation as unknown as { findFirst: unknown; findMany: unknown };
    const prismaObj = prisma as unknown as { $transaction: unknown };

    const originalAppFindMany = prismaApp.findMany;
    const originalObsFindFirst = prismaObs.findFirst;
    const originalTx = prismaObj.$transaction;

    prismaApp.findMany = async () => [dummyApp];
    prismaObs.findFirst = async () => null; // 이전 관측 없음
    prismaObj.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
      const fakeTx = {
        marketObservation: {
          createMany: async () => ({ count: 1 }),
          updateMany: async () => ({ count: 1 }),
        },
      };
      return fn(fakeTx);
    };

    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      // Apple lookup
      if (urlStr.includes("itunes.apple.com/lookup")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                bundleId: "com.test.app",
                trackId: 12345,
                trackName: "테스트 앱",
                primaryGenreId: 7005,
                primaryGenreName: "카드",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Apple RSS
      if (urlStr.includes("itunes.apple.com") && urlStr.includes("/rss/topfreeapplications/")) {
        return new Response(
          JSON.stringify({
            feed: {
              entry: [
                {
                  id: { attributes: { "im:bundleId": "com.other.app" } },
                  "im:name": { label: "다른 앱" },
                  category: { attributes: { "im:id": "7005", label: "카드" } },
                },
                {
                  id: { attributes: { "im:bundleId": "com.test.app" } },
                  "im:name": { label: "테스트 앱" },
                  category: { attributes: { "im:id": "7005", label: "카드" } },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Play detail
      if (urlStr.includes("play.google.com/store/apps/details")) {
        return new Response(
          `<!doctype html><html><body>
            <script type="application/ld+json">{"@type":"SoftwareApplication","applicationCategory":"GAME_BOARD"}</script>
            <a href="/store/apps/category/GAME_BOARD" aria-label="보드">보드</a>
          </body></html>`,
          { status: 200 },
        );
      }
      // Play category chart
      if (urlStr.includes("play.google.com/store/apps/category/")) {
        return new Response(
          `<!doctype html><html><body>
            <a href="/store/apps/details?id=com.other.play">Other</a>
            <a href="/store/apps/details?id=com.test.app">Test</a>
          </body></html>`,
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    try {
      const result = await collectCategoryRanks(new Date(), {
        fetchImpl: mockFetch as unknown as typeof fetch,
        sleep: async () => {},
      });

      assert.equal(result.collectedCount, 2);
      assert.equal(result.items.length, 2);

      const appleItem = result.items.find((i) => i.market === "app-store");
      assert.ok(appleItem);
      assert.equal(appleItem?.rank, 2);
      assert.equal(appleItem?.categoryName, "카드");
      assert.equal(appleItem?.change, "첫 관측 (2위)");

      const playItem = result.items.find((i) => i.market === "google-play");
      assert.ok(playItem);
      assert.equal(playItem?.rank, 2);
      assert.equal(playItem?.categoryName, "보드");
      assert.equal(playItem?.change, "첫 관측 (2위)");
    } finally {
      prismaApp.findMany = originalAppFindMany;
      prismaObs.findFirst = originalObsFindFirst;
      prismaObj.$transaction = originalTx;
    }
  });

  it("getLatestCategoryRankSummaries는 당일 MarketObservation에서 중복 없이 순위 항목을 반환한다", async () => {
    const prismaObs = prisma.marketObservation as unknown as { findMany: unknown };
    const originalObsFindMany = prismaObs.findMany;
    prismaObs.findMany = async () => [
      {
        appId: "app-1",
        target: "app-store:7005",
        country: "kr",
        value: {
          appName: "맞고세이프",
          market: "app-store",
          categoryName: "카드",
          rank: 14,
          previousRank: 16,
          change: "2계단 상승 (▲2)",
        },
      },
      {
        appId: "app-1",
        target: "app-store:7005",
        country: "kr",
        value: {
          appName: "맞고세이프",
          market: "app-store",
          categoryName: "카드",
          rank: 14,
          previousRank: 16,
          change: "2계단 상승 (▲2)",
        },
      },
    ];

    try {
      const summaries = await getLatestCategoryRankSummaries(new Date());
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].appName, "맞고세이프");
      assert.equal(summaries[0].rank, 14);
      assert.equal(summaries[0].change, "2계단 상승 (▲2)");
    } finally {
      prismaObs.findMany = originalObsFindMany;
    }
  });
});
