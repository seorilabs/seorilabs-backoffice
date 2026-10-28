import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { KeywordRankChart } from "./KeywordRankChart";
import { buildKeywordHistory, normalizeKeywordSelection } from "@/lib/market/keyword-history";

test("AC-2: 초기 HTML에서는 필터 변경을 막아 준비 전 선택이 사라지지 않는다", () => {
  const app = { id: "app", displayName: "앱", iosBundle: "com.example.app", status: "ACTIVE", revision: 3, countries: ["kr", "us"], keywords: ["sea", "brand"] };
  const now = new Date("2026-10-12T14:00:00Z");
  const selection = normalizeKeywordSelection([app], {}, now);
  const history = buildKeywordHistory(app, selection, [], [], now);
  const noop = () => {};
  const router: AppRouterInstance = { back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop, bfcacheId: "qa-document" };
  const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router },
    createElement(KeywordRankChart, { apps: [app], app, selection, history, today: selection.day })));
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /화면 준비 중/);
  assert.match(html, /aria-label="기준일 조회"/);
  const controls = html.match(/<(?:select|input|button)\b[^>]*>/g) ?? [];
  assert.ok(controls.length >= 10);
  assert.ok(controls.every(control => /\bdisabled=""/.test(control)), "필터·비교·상세 조작은 이벤트 처리 준비 뒤 활성화한다");
});


test("AC-5: 관측 저장 뒤 수집 실패는 재시도 여부를 추정하지 않고 상세에도 표시한다", () => {
  const app = { id: "app", displayName: "앱", iosBundle: "com.example.app", status: "ACTIVE", revision: 3, countries: ["kr"], keywords: ["sea"] };
  const now = new Date("2026-10-12T14:00:00Z");
  const selection = normalizeKeywordSelection([app], {}, now);
  const history = buildKeywordHistory(app, selection, [{ appId: app.id, target: "sea", country: "kr", day: new Date("2026-10-12"), observedAt: new Date("2026-10-12T12:00:00Z"), value: { rank: null }, sourceUrl: "https://itunes.apple.com/search" }], [{ appId: app.id, source: "apple-keyword", target: "kr:sea", status: "failed", startedAt: new Date("2026-10-12T13:00:00Z"), completedAt: new Date("2026-10-12T13:01:00Z") }], now);
  const noop = () => {};
  const router: AppRouterInstance = { back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop, bfcacheId: "qa-document" };
  const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, createElement(KeywordRankChart, { apps: [app], app, selection, history, today: selection.day })));
  assert.match(html, /sea · 결과 목록에 없음 · 최근 수집 실패/);
  assert.doesNotMatch(html, /재시도/);
});

test("Play 관측 기록에는 수집 활성화나 국가 적용을 단정하지 않는다",()=>{
  const app={id:"app",displayName:"앱",iosBundle:null,playPackage:"com.example.app",status:"ACTIVE",revision:1,countries:["us"],keywords:["sea"]};
  const now=new Date("2026-10-28T12:00:00Z"),selection=normalizeKeywordSelection([app],{market:"google-play"},now),history=buildKeywordHistory(app,selection,[],[],now);
  const noop=()=>{},router:AppRouterInstance={back:noop,forward:noop,refresh:noop,push:noop,replace:noop,prefetch:noop,bfcacheId:"qa"};
  const html=renderToStaticMarkup(createElement(AppRouterContext.Provider,{value:router},createElement(KeywordRankChart,{apps:[app],app,selection,history,today:selection.day})));
  const note=html.match(/<p class="text-xs text-neutral-600">(.*?)<\/p>/)?.[1]??"";
  assert.match(note,/관측 기록/);assert.match(note,/요청 조건/);assert.doesNotMatch(note,/KST 수집/);
});
