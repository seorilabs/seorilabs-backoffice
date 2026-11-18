import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { createChannelMessage, renderSlackMessage } from "@/lib/notifications/channel";
import { messageRender, renderPayload } from "@/lib/notifications/format";
import { operationalInterestCard, type OperationalEventInput } from "@/lib/platform/operational-events";
import { richPlain } from "./rich-text";

const base: OperationalEventInput = {
  version: 1, eventId: "synthetic_preview_12345", occurredAt: "2026-11-18T01:00:00Z",
  type: "ad.reward.delivered", appId: "sample", outcome: "delivered", attributes: {},
};

function storedMessage(event: OperationalEventInput, app = "예제 앱") {
  const card = operationalInterestCard(event, app);
  const stored = messageRender("OPERATIONAL_EVENT", renderPayload(card) as Prisma.JsonValue)!;
  return { stored, message: renderSlackMessage(stored.text, stored) };
}

function assertPreview(message: ReturnType<typeof renderSlackMessage>, expected: string) {
  assert.equal(message.text.split("\n")[0], expected);
  assert.equal(message.blocks[0].type, "rich_text");
  const sections = message.blocks[0].elements as Parameters<typeof richPlain>[0][];
  assert.equal(sections.map(richPlain).join("\n"), expected);
  assert.equal(message.text.split(expected).length, 2, "같은 요약을 제목과 본문에 반복하지 않는다");
}

test("광고 푸시와 첫 본문 블록에 앱·플랫폼·처리 결과·보상을 함께 표시한다", () => {
  for (const [clientPlatform, platform] of [["android", "Android"], ["ios", "iOS"], ["apps_in_toss", "앱인토스"], [undefined, "플랫폼 미확인"]] as const) {
    for (const rewardAmount of [10, 0, undefined]) {
      const { message } = storedMessage({ ...base, attributes: { ...(clientPlatform ? { clientPlatform } : {}), rewardKey: "daily_crystal_bonus", ...(rewardAmount === undefined ? {} : { rewardAmount }), countryCode: "US" } });
      assertPreview(message, `🎬 [예제 앱 · ${platform}] 광고 보상 지급 완료 — daily_crystal_bonus: ${rewardAmount ?? "미확인"}`);
      assert.match(message.text, /국가: US/);
      assert.match(message.text, /2026-11-18 10:00 KST/);
    }
  }
});

test("결제 푸시는 실제·테스트·미확인과 신규 결제·복원·이전을 구분한다", () => {
  for (const [platform, market] of [["google_play", "구글플레이"], ["app_store", "앱스토어"], ["apps_in_toss", "앱인토스"]] as const) {
    for (const [isTestPurchase, environment] of [[false, "실제 주문"], [true, "테스트 주문"], [undefined, "구분 미확인"]] as const) {
      for (const [grantKind, action] of [["purchase", "결제 발생"], ["restore", "구매 복원"], ["transfer", "소유권 이전"], [undefined, "결제 권리 지급 완료"]] as const) {
        const { message } = storedMessage({ ...base, type: "iap.granted", attributes: { platform, ...(isTestPurchase === undefined ? {} : { isTestPurchase }), ...(grantKind ? { grantKind } : {}), entitlementId: "sp_veiled_chameleon", platformUserId: "pu_01ARZ3NDEKTSV4RRFFQ69G5FAV", countryCode: "US" } });
        assertPreview(message, `💳 [예제 앱 · ${market}] ${environment} ${action} — 지급항목: sp_veiled_chameleon`);
        assert.match(message.text, /사용자 ID: pu_01ARZ3NDEKTSV4RRFFQ69G5FAV/);
        assert.match(message.text, /결제 국가: US/);
      }
    }
  }
});

test("실패 푸시는 앱과 오류를 먼저 알리고 기존 진단 정보를 보존한다", () => {
  for (const type of ["ad.reward.delivery_failed", "iap.completion_failed"] as const) {
    const { message } = storedMessage({ ...base, type, attributes: { clientPlatform: "android", platform: "google_play", isTestPurchase: false, provider: "admob", placementId: "daily_bonus", errorCode: "PROVIDER_TIMEOUT" } });
    assertPreview(message, type.startsWith("ad.")
      ? "❌ [예제 앱 · Android] 광고 보상 지급 실패 — 오류: PROVIDER_TIMEOUT"
      : "❌ [예제 앱 · 구글플레이] 실제 주문 결제 완료 처리 실패 — 오류: PROVIDER_TIMEOUT");
    assert.match(message.text, /지급 원장에서 실패와 재시도 결과를 확인하세요/);
    if (type.startsWith("ad.")) {
      assert.match(message.text, /제공사: admob/);
      assert.match(message.text, /광고 위치: daily_bonus/);
    }
    assert.doesNotMatch(message.text, /국가:/);
  }
});

test("본문 요약의 앱 이름과 보상 식별자는 마크다운으로 변형하지 않는다", () => {
  const { message } = storedMessage({ ...base, attributes: { rewardKey: "daily_*bonus*", rewardAmount: 0 } }, "예제_*앱*");
  assertPreview(message, "🎬 [예제_*앱* · 플랫폼 미확인] 광고 보상 지급 완료 — daily_*bonus*: 0");
});

test("실제 Slack 전송 payload도 같은 요약으로 시작한다", async () => {
  const { stored, message } = storedMessage({ ...base, attributes: { clientPlatform: "android", rewardKey: "crystal", rewardAmount: 10 } });
  const original = globalThis.fetch;
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://slack.com/api/chat.postMessage");
    sent = JSON.parse(String(init?.body));
    return Response.json({ ok: true, ts: "1794963600.000001" });
  };
  try {
    assert.equal((await createChannelMessage("CSYNTHETIC", stored.text, { ...stored, botToken: "synthetic" })).ok, true);
    assert.equal(sent?.text, message.text);
    assert.deepEqual(sent?.blocks, message.blocks);
  } finally {
    globalThis.fetch = original;
  }
});
