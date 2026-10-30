import assert from "node:assert/strict";
import { test } from "node:test";
import { rankReportSvg, rankReportText, type RankReport } from "./rank-report";
import type { KeywordRow } from "./keyword-monitoring";
import { markdownElements, markdownPlain } from "@/lib/slack/rich-text";
const row: KeywordRow = {
  appId: "a",
  appName: "삼국지 풍운록",
  country: "kr",
  term: "three kingdoms",
  revision: 1,
  state: "수집됨",
  rank: 68,
  rankLabel: "68위",
  previousRank: 140,
  previousDay: "2026-10-16",
  change: "72계단 상승",
  observedAt: new Date("2026-10-17T12:20:00Z"),
  sourceUrl: "https://itunes.apple.com/search",
};
const reportFixture = ():RankReport => ({version:1,day:"2026-10-17",capturedAt:new Date().toISOString(),rows:[{...row,observedAt:row.observedAt!.toISOString()}],items:[{...row,observedAt:row.observedAt!.toISOString(),reason:"상위 100개 진입",score:900,points:[{day:"2026-10-15",rank:null,state:"missing"},{day:"2026-10-16",rank:null,state:"outside"},{day:"2026-10-17",rank:null,state:"missing"}]}]});
test("보고서는 실제 순위와 마켓, 출처와 반환 범위를 표기한다",()=>{
 const report=reportFixture();report.items[0].market="google-play";report.items[0].source="google-play-web";report.items[0].resultCount=80;
 const text=rankReportText(report,"https://example.com");assert.match(text,/140위.*68위/);assert.match(text,/Google Play 웹/);assert.match(text,/설정 요청/);assert.match(text,/반환 80개/);
});
test("관측 시각의 연월일을 Slack의 중첩 번호 목록으로 바꾸지 않는다", () => {
  const report = reportFixture();
  report.items[0].previousAt = "2026-10-16T11:20:00Z";
  const text = rankReportText(report, "https://example.com");
  assert.doesNotMatch(JSON.stringify(markdownElements(text)), /"style":"ordered"/);
  assert.match(markdownPlain(text), /2026\. 10\. 16\./);
  assert.match(markdownPlain(text), /2026\. 10\. 17\./);
});
test("첫 관측은 이전 기록 없음과 현재 관측 시각을 나눠 표시한다", () => {
  const report = reportFixture();
  report.items[0].previousDay = null;
  report.items[0].previousAt = null;
  const text = markdownPlain(rankReportText(report, "https://example.com"));
  assert.match(text, /이전 관측 없음 · 2026\. 10\. 17\./);
});
test("없는 날과 결과 목록 밖을 201위로 그리지 않고 국가·검색어를 보존", () => {
  const report = reportFixture();
  assert.equal(report.items[0].points.at(-2)?.state, "outside");
  assert.equal(report.items[0].points.at(-1)?.state, "missing");
  const svg = rankReportSvg(report);
  assert.match(svg, /목록 밖/);
  assert.match(svg, /미수집/);
  assert.doesNotMatch(svg, />201</);
  assert.match(svg, /KR · three kingdoms/);
});

test("압축 그래프는 인접한 목록 밖·미수집을 단일 기호와 범례로 구분한다", async () => {
  const { rankSlackSvg } = await import("./rank-report");
  const report = reportFixture();
  report.items[0].points.at(-1)!.state = "outside";
  const svg = rankSlackSvg(report);
  assert.match(svg, /○ 결과 목록 밖 · × 미수집 · ! 자료 오류/);
  assert.match(svg, />○<\/text>/);
  assert.match(svg, />×<\/text>/);
  assert.doesNotMatch(svg, />목록 밖<\/text>/);
});

test("불변 보고서 주소는 전체 snapshot을 구분하고 발행시각만의 차이는 제외한다", async () => {
  const { rankReportKey } = await import("./rank-report");
  const report = reportFixture();
  assert.equal(
    rankReportKey(report),
    rankReportKey({ ...report, capturedAt: "other" }),
  );
  assert.notEqual(
    rankReportKey(report),
    rankReportKey({
      ...report,
      rows: [{ ...report.rows[0], state: "미수집" }],
    }),
  );
});

test("MySQL JSON의 키 순서가 달라도 같은 보고서를 다시 발행하지 않는다",async()=>{
 const {sameRankReportContent}=await import("./rank-report");
 const report=reportFixture();
 const reorder=(value:unknown):unknown=>Array.isArray(value)?value.map(reorder):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).reverse().map(([key,nested])=>[key,reorder(nested)])):value;
 const stored=reorder(report) as typeof report;
 assert.equal(sameRankReportContent(report,stored),true);
 assert.equal(sameRankReportContent(report,{...stored,capturedAt:"other"}),true);
 assert.equal(sameRankReportContent(report,{...stored,rows:[{...stored.rows[0],state:"미수집"}]}),false);
});
