import assert from "node:assert/strict";
import test from "node:test";
import {
  createApplePublicClient,
  keywordRank,
  significantRankChange,
  describeRankChange,
  parseOfficialFeed,
} from "./public-sources";
test("검색 순서는 1부터 세고 권외·5위 변화·첫 관측을 구분함", () => {
  assert.equal(keywordRank([{ trackId: 4 }, { trackId: 8 }], 8), 2);
  assert.equal(keywordRank([], 8), null);
  assert.equal(significantRankChange(10, 14), false);
  assert.equal(significantRankChange(10, 15), true);
  assert.equal(significantRankChange(null, 200), true);
});
test("순서 변화를 방향과 계단 수로 설명하고 작은 숫자를 상승으로 읽음", () => {
  assert.deepEqual(describeRankChange(77, 70), { direction: "상승", text: "77위 → 70위 (7계단 상승)" });
  assert.deepEqual(describeRankChange(23, 47), { direction: "하락", text: "23위 → 47위 (24계단 하락)" });
  assert.equal(describeRankChange(null, 120).direction, "진입");
  assert.equal(describeRankChange(120, null).text, "120위 → 200위 밖 (검색 결과에서 사라짐)");
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
test("설명을 포함해 2MiB를 넘는 정상 검색 결과의 마지막 순위까지 수집함", async () => {
  const results = Array.from({ length: 200 }, (_, index) => ({
    trackId: index + 1,
    trackName: "Sample",
    description: "x".repeat(11_000),
  }));
  const client = createApplePublicClient({
    sleep: async () => {},
    fetchImpl: async () => Response.json({ results }),
  });
  const apps = await client.search("match 3", "kr");
  assert.equal(apps.length, 200);
  assert.equal(keywordRank(apps, 200), 200);
  await assert.rejects(client.lookup({ id: "200" }, "kr"), /SOURCE_RESPONSE_TOO_LARGE/);
});
test("검색 응답의 유한한 크기 제한과 결과 200개 제한을 유지함", async () => {
  const oversized = createApplePublicClient({
    sleep: async () => {},
    fetchImpl: async () => new Response("x".repeat(8 * 1024 * 1024 + 1)),
  });
  await assert.rejects(oversized.search("puzzle", "us"), /SOURCE_RESPONSE_TOO_LARGE/);
  const tooMany = createApplePublicClient({
    sleep: async () => {},
    fetchImpl: async () => Response.json({
      results: Array.from({ length: 201 }, (_, index) => ({ trackId: index + 1, trackName: "Sample" })),
    }),
  });
  await assert.rejects(tooMany.search("puzzle", "us"));
});
test("공식 피드는 허용 호스트만 저장하고 XML 외부 엔티티를 거부함", () => {
  const rss =
    "<rss><channel><item><title>Policy</title><link>https://developer.apple.com/news/example</link><pubDate>Thu, 08 Oct 2026 00:00:00 GMT</pubDate></item><item><title>Bad</title><link>https://evil.invalid</link><pubDate>Thu, 08 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>";
  assert.equal(parseOfficialFeed(rss, "apple-news").length, 1);
  assert.throws(() => parseOfficialFeed("<!DOCTYPE x>" + rss, "apple-news"));
});
