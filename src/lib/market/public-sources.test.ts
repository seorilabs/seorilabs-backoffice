import assert from "node:assert/strict";
import test from "node:test";
import {
  createApplePublicClient,
  keywordRank,
  significantRankChange,
  parseOfficialFeed,
} from "./public-sources";
test("검색 순서는 1부터 세고 권외·5위 변화·첫 관측을 구분함", () => {
  assert.equal(keywordRank([{ trackId: 4 }, { trackId: 8 }], 8), 2);
  assert.equal(keywordRank([], 8), null);
  assert.equal(significantRankChange(10, 14), false);
  assert.equal(significantRankChange(10, 15), true);
  assert.equal(significantRankChange(null, 200), true);
});
test("Apple 제한 응답을 재시도하고 검색 결과 상한과 country를 고정함", async () => {
  let calls = 0;
  const urls: string[] = [];
  const client = createApplePublicClient({
    sleep: async () => {},
    fetchImpl: async (url) => {
      urls.push(String(url));
      return ++calls === 1
        ? new Response(null, { status: 429 })
        : Response.json({ results: [{ trackId: 8, trackName: "Sample" }] });
    },
  });
  assert.equal((await client.search("lizard", "us"))[0].trackId, 8);
  assert.equal(calls, 2);
  assert.match(urls[0], /limit=200/);
  assert.match(urls[0], /country=us/);
});
test("공식 피드는 허용 호스트만 저장하고 XML 외부 엔티티를 거부함", () => {
  const rss =
    "<rss><channel><item><title>Policy</title><link>https://developer.apple.com/news/example</link><pubDate>Thu, 08 Oct 2026 00:00:00 GMT</pubDate></item><item><title>Bad</title><link>https://evil.invalid</link><pubDate>Thu, 08 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>";
  assert.equal(parseOfficialFeed(rss, "apple-news").length, 1);
  assert.throws(() => parseOfficialFeed("<!DOCTYPE x>" + rss, "apple-news"));
});
