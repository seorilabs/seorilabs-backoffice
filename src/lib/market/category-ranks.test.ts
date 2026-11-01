import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAppleCategoryChart,
  parsePlayCategoryChart,
  parsePlayAppCategory,
  parseAppleLookupCategory,
  describeCategoryRankChange,
  formatCategoryRankSummary,
  type CategoryRankSummaryItem,
} from "./category-ranks";

describe("category-ranks", () => {
  describe("parseAppleCategoryChart", () => {
    it("Apple RSS JSON 응답에서 앱 번들 ID와 순위를 정확히 파싱한다", () => {
      const sampleFeed = JSON.stringify({
        feed: {
          entry: [
            {
              id: {
                label: "https://apps.apple.com/app/id1",
                attributes: { "im:id": "1", "im:bundleId": "com.example.first" },
              },
              "im:name": { label: "첫번째 앱" },
              category: {
                attributes: { "im:id": "7005", label: "카드", term: "Card" },
              },
            },
            {
              id: {
                label: "https://apps.apple.com/app/id2",
                attributes: { "im:id": "2", "im:bundleId": "com.example.target" },
              },
              "im:name": { label: "대상 앱" },
              category: {
                attributes: { "im:id": "7005", label: "카드", term: "Card" },
              },
            },
          ],
        },
      });

      const parsed = parseAppleCategoryChart(sampleFeed);
      assert.equal(parsed.length, 2);
      assert.deepEqual(parsed[0], {
        bundleId: "com.example.first",
        trackId: "1",
        title: "첫번째 앱",
        categoryId: "7005",
        categoryName: "카드",
        rank: 1,
      });
      assert.deepEqual(parsed[1], {
        bundleId: "com.example.target",
        trackId: "2",
        title: "대상 앱",
        categoryId: "7005",
        categoryName: "카드",
        rank: 2,
      });
    });

    it("단일 항목 객체도 배열로 정규화하여 파싱한다", () => {
      const singleFeed = JSON.stringify({
        feed: {
          entry: {
            id: {
              attributes: { "im:id": "123", "im:bundleId": "com.single.app" },
            },
            "im:name": { label: "단일 앱" },
            category: { attributes: { "im:id": "6014", label: "게임" } },
          },
        },
      });
      const parsed = parseAppleCategoryChart(singleFeed);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].bundleId, "com.single.app");
      assert.equal(parsed[0].rank, 1);
    });

    it("비정상 JSON이나 entry 부재 시 빈 배열을 반환한다", () => {
      assert.deepEqual(parseAppleCategoryChart("invalid json"), []);
      assert.deepEqual(parseAppleCategoryChart(JSON.stringify({ feed: {} })), []);
    });
  });

  describe("parsePlayCategoryChart", () => {
    it("Google Play 카테고리 HTML에서 고유 앱 패키지명 목록을 순서대로 추출한다", () => {
      const html = `
        <!doctype html><html><body>
          <div><a href="/store/apps/details?id=com.play.app1">App 1</a></div>
          <div><a href="/store/apps/details?id=com.play.app2&hl=ko">App 2</a></div>
          <div><a href="/store/apps/details?id=com.play.app1">App 1 duplicate</a></div>
          <div aria-label="Ad"><a href="/store/apps/details?id=com.ad.app">Ad</a></div>
          <div><a href="/store/apps/details?id=com.play.app3">App 3</a></div>
        </body></html>
      `;

      const packages = parsePlayCategoryChart(html);
      assert.deepEqual(packages, ["com.play.app1", "com.play.app2", "com.play.app3"]);
    });

    it("응답이 비어있거나 차단/비정상 응답 시 에러를 던지거나 빈 배열을 반환한다", () => {
      assert.deepEqual(parsePlayCategoryChart(""), []);
      assert.throws(() => parsePlayCategoryChart("recaptcha challenge error"), /PLAY_BLOCKED/);
    });
  });

  describe("parsePlayAppCategory", () => {
    it("Google Play 상세 HTML에서 카테고리 ID와 표시명을 파싱한다", () => {
      const html = `
        <script type="application/ld+json">{"@type":"SoftwareApplication","applicationCategory":"GAME_BOARD"}</script>
        <a href="/store/apps/category/GAME_BOARD" aria-label="보드">보드</a>
      `;
      const result = parsePlayAppCategory(html);
      assert.deepEqual(result, { categoryId: "GAME_BOARD", categoryName: "보드" });
    });

    it("HTML이 없거나 카테고리가 없으면 null을 반환한다", () => {
      assert.equal(parsePlayAppCategory(""), null);
      assert.equal(parsePlayAppCategory("<div>hello</div>"), null);
    });
  });

  describe("parseAppleLookupCategory", () => {
    it("Apple Lookup 결과 객체에서 장르 ID와 장르명을 파싱한다", () => {
      const app = {
        primaryGenreId: 7005,
        primaryGenreName: "Card",
        genres: ["Card", "Games"],
      };
      const result = parseAppleLookupCategory(app);
      assert.deepEqual(result, { categoryId: "7005", categoryName: "Card" });
    });

    it("객체가 비어있으면 null을 반환한다", () => {
      assert.equal(parseAppleLookupCategory(null), null);
      assert.equal(parseAppleLookupCategory({}), null);
    });
  });

  describe("describeCategoryRankChange", () => {
    it("순위 변동 없음", () => {
      assert.equal(describeCategoryRankChange(10, 10), "변동 없음");
      assert.equal(describeCategoryRankChange(null, null), "순위권 밖 유지");
    });

    it("순위 상승 및 하락", () => {
      assert.equal(describeCategoryRankChange(15, 10), "5계단 상승 (▲5)");
      assert.equal(describeCategoryRankChange(10, 14), "4계단 하락 (▼4)");
    });

    it("신규 진입 및 이탈", () => {
      assert.equal(describeCategoryRankChange(null, 25), "순위권 진입 (25위)");
      assert.equal(describeCategoryRankChange(25, null), "순위권 이탈 (이전: 25위)");
      assert.equal(describeCategoryRankChange(undefined, 12), "첫 관측 (12위)");
    });
  });

  describe("formatCategoryRankSummary", () => {
    it("슬랙 메시지용 카테고리 순위 블록을 올바르게 포맷팅한다", () => {
      const items: CategoryRankSummaryItem[] = [
        {
          appName: "맞고세이프",
          market: "app-store",
          country: "kr",
          categoryName: "게임 > 카드",
          rank: 14,
          previousRank: 16,
          change: "2계단 상승 (▲2)",
        },
        {
          appName: "맞고세이프",
          market: "google-play",
          country: "kr",
          categoryName: "게임 > 카드",
          rank: 28,
          previousRank: 27,
          change: "1계단 하락 (▼1)",
        },
      ];

      const formatted = formatCategoryRankSummary(items);
      assert.ok(formatted.includes("*카테고리 순위 관측*"));
      assert.ok(formatted.includes("• **맞고세이프** · App Store · KR 게임 > 카드 14위 (이전: 16위 · 2계단 상승 (▲2))"));
      assert.ok(formatted.includes("• **맞고세이프** · Google Play 웹 · KR 게임 > 카드 28위 (이전: 27위 · 1계단 하락 (▼1))"));
    });

    it("항목이 없으면 빈 문자열을 반환한다", () => {
      assert.equal(formatCategoryRankSummary([]), "");
    });
  });
});
