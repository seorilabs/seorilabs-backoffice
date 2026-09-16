import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  entitlementGroup,
  iapRowDedupeKey,
  iapRowText,
  iapSummaryDedupeKey,
  iapSummaryRender,
  iapThreadName,
  marketLabel,
  summarizeIapGrants,
  testPurchaseState,
} from "@/lib/notifications/iap-summary";

// 여기가 뒤집히면 앱인토스 결제가 전부 실거래로 표시된다. platform providers/toss 는
// 이 값을 세팅하지 않으므로 키가 아예 오지 않는다.
test("테스트 주문 여부는 3상태이고 부재는 실거래로 접지 않는다", () => {
  assert.equal(testPurchaseState({ isTestPurchase: true }), "test");
  assert.equal(testPurchaseState({ isTestPurchase: false }), "real");
  assert.equal(testPurchaseState({ platform: "apps_in_toss" }), "unknown");
  assert.equal(testPurchaseState({ isTestPurchase: null }), "unknown");
  assert.equal(testPurchaseState(null), "unknown");
  assert.equal(testPurchaseState([1, 2]), "unknown");
});

test("마켓은 사람이 읽는 이름으로, 모르는 값은 원문 그대로 남긴다", () => {
  assert.equal(marketLabel("app_store"), "App Store");
  assert.equal(marketLabel("apps_in_toss"), "앱인토스");
  assert.equal(marketLabel("new_market"), "new_market");
  assert.equal(marketLabel(null), "unknown");
});

test("상품 권리는 접두사로 묶고 규약이 없으면 ID 를 그대로 쓴다", () => {
  assert.equal(entitlementGroup("sp_moonlight_crested"), "sp_*");
  assert.equal(entitlementGroup("ck_starlight_accessory_set"), "ck_*");
  assert.equal(entitlementGroup("premium"), "premium");
  assert.equal(entitlementGroup("_leading"), "_leading");
});

const rows = [
  { occurredAt: new Date("2026-09-16T12:40:55Z"), attributes: { platform: "app_store", entitlementId: "sp_moonlight_crested", isTestPurchase: false } },
  { occurredAt: new Date("2026-09-16T12:32:53Z"), attributes: { platform: "app_store", entitlementId: "sp_aurora_skink", isTestPurchase: true } },
  { occurredAt: new Date("2026-09-16T11:11:00Z"), attributes: { platform: "apps_in_toss", entitlementId: "ft_rack_pack_1" } },
];

test("요약은 마켓·상품 분포와 테스트·미확인 건수를 센다", () => {
  const facts = summarizeIapGrants({
    displayName: "도마뱀 테라리움",
    dateKey: "2026-09-16",
    todayTotal: 3,
    rows,
  });
  assert.ok(facts);
  assert.equal(facts.latestAt.toISOString(), "2026-09-16T12:40:55.000Z");
  assert.equal(facts.previousAt?.toISOString(), "2026-09-16T12:32:53.000Z");
  assert.deepEqual(facts.markets, [["App Store", 2], ["앱인토스", 1]]);
  assert.deepEqual(facts.products, [["ft_*", 1], ["sp_*", 2]].sort((a, b) => (b[1] as number) - (a[1] as number)));
  assert.equal(facts.testCount, 1);
  assert.equal(facts.unknownCount, 1);
});

test("결제가 없으면 알릴 요약이 없다", () => {
  assert.equal(summarizeIapGrants({ displayName: "x", dateKey: "2026-09-16", todayTotal: 0, rows: [] }), null);
});

test("카드는 앱·건수를 제목으로 올리고 미확인을 드러낸다", () => {
  const facts = summarizeIapGrants({ displayName: "도마뱀 테라리움", dateKey: "2026-09-16", todayTotal: 3, rows })!;
  const render = iapSummaryRender(facts);
  assert.equal(render.embed?.title, "💳 도마뱀 테라리움 · 결제 3건");
  assert.equal(render.embed?.footer, "2026-09-16 KST");
  assert.equal(render.embed?.timestamp, "2026-09-16T12:40:55.000Z");
  assert.match(render.text, /마켓 App Store 2 · 앱인토스 1/);
  assert.match(render.text, /테스트 주문 1건 · 미확인 1건/);
  // 누적은 내지 않는다. IAP 에는 신규 계정의 platformUserBaseline 같은 기준이 없어
  // "수신 시작 이후" 합계를 누적처럼 보이게 하면 거짓말이 된다.
  assert.doesNotMatch(render.text, /누적/);
});

test("테스트·미확인이 없으면 그 줄을 통째로 뺀다", () => {
  const facts = summarizeIapGrants({
    displayName: "도마뱀 테라리움",
    dateKey: "2026-09-16",
    todayTotal: 1,
    rows: [{ occurredAt: new Date("2026-09-16T12:40:55Z"), attributes: { platform: "google_play", entitlementId: "gem_100", isTestPurchase: false } }],
  })!;
  const { text } = iapSummaryRender(facts);
  assert.doesNotMatch(text, /테스트 주문|미확인/);
  assert.doesNotMatch(text, /직전 간격/);
});

test("건별 행은 실거래에만 표식을 붙이지 않는다", () => {
  const base = { ordinal: 2, occurredAt: new Date("2026-09-16T12:40:55Z"), previousAt: new Date("2026-09-16T12:32:55Z"), market: "App Store" };
  assert.equal(
    iapRowText({ ...base, entitlementId: "sp_moonlight_crested", test: "real" }),
    "`#2` · 21:40 · 직전 +8분 · App Store · sp_moonlight_crested",
  );
  assert.match(iapRowText({ ...base, entitlementId: "sp_aurora_skink", test: "test" }), /🧪테스트$/);
  assert.match(iapRowText({ ...base, entitlementId: "ft_rack_pack_1", test: "unknown" }), /❔미확인$/);
});

// 채널 ID 봉인으로 목적지가 바뀌면 카드도 새로 만들어져야 한다. 목적지가 키에 없으면
// 카드는 폴백 채널에 남고 쓰레드 행만 새 채널로 가서 부모를 영영 못 찾는다.
test("카드 dedupe 키에는 목적지가 들어간다", () => {
  assert.notEqual(
    iapSummaryDedupeKey("iap", "lizard-tycoon", "2026-09-16"),
    iapSummaryDedupeKey("action-events", "lizard-tycoon", "2026-09-16"),
  );
  assert.equal(iapRowDedupeKey("iap_abc"), "iap-row:iap_abc");
  assert.equal(iapThreadName("도마뱀 테라리움", "2026-09-16"), "도마뱀 테라리움 결제 2026-09-16");
});

// 쓰레드 게시는 kind 가 아니라 payload 로 구분한다. NotificationKind 는 MySQL ENUM 이라
// 값 추가에 ALTER MODIFY 가 필요하고 expand-only 게이트가 막는다.
test("소스 계약: IAP 는 새 kind 없이 기존 전달 경로를 탄다", () => {
  const src = readFileSync("src/lib/notifications/iap-summary.ts", "utf8");
  assert.match(src, /kind: "OPERATIONAL_EVENT"/);
  assert.match(src, /editable: true/);
  assert.match(src, /thread: \{/);
  assert.equal(/kind: "IAP/.test(src), false);
});
