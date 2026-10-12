import assert from "node:assert/strict";
import test from "node:test";
import { initialIapAppSlug, selectWritableIapApps, type IapAppCandidate } from "./iap-apps";

const game = (slug: string, extra: Partial<IapAppCandidate> = {}): IapAppCandidate => ({
  slug, platformAppId: slug, displayName: slug, type: "GAME", status: "ACTIVE", ...extra,
});

test("AC-2: 활성 게임의 정상 비어 있지 않은 카탈로그만 선택할 수 있다", async () => {
  const probed: string[] = [];
  const result = await selectWritableIapApps([
    game("good"), game("empty"), game("unsupported"), game("offline"), game("mismatch"),
    game("paused", {status: "PAUSED"}), game("hidden", {status: "DEPRECATED"}),
    game("app", {type: "APP"}), game("unbound", {platformAppId: null}),
  ], async (appId) => {
    probed.push(appId);
    if (appId === "unsupported") throw Object.assign(new Error(), {code: "auth_forbidden"});
    if (appId === "offline") throw Object.assign(new Error(), {code: "network_error"});
    return {appId: appId === "mismatch" ? "other" : appId, entitlements: appId === "empty" ? [] : ["premium"]};
  });
  assert.deepEqual(result.apps, [{slug: "good", displayName: "good"}]);
  assert.equal(result.unavailableCount, 2);
  assert.equal(result.emptyCount, 1);
  assert.deepEqual(probed.sort(), ["good", "empty", "unsupported", "offline", "mismatch"].sort());
});

test("AC-2: 카탈로그 조회 동시 실행은 4개 이하이고 표시 순서를 보존한다", async () => {
  let running = 0, maximum = 0;
  const candidates = Array.from({length: 10}, (_, i) => game(`game-${i}`));
  const result = await selectWritableIapApps(candidates, async (appId) => {
    running++; maximum = Math.max(maximum, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running--;
    return {appId, entitlements: ["premium"]};
  });
  assert.ok(maximum > 0 && maximum <= 4);
  assert.deepEqual(result.apps.map((app) => app.slug), candidates.map((app) => app.slug));
});

test("AC-3: 잘못된 게임 링크는 다른 게임을 기본 선택하지 않는다", () => {
  const apps = [{slug: "good", displayName: "게임"}];
  assert.equal(initialIapAppSlug(apps), "good");
  assert.equal(initialIapAppSlug(apps, "good"), "good");
  assert.equal(initialIapAppSlug(apps, "unsupported"), "");
  assert.equal(initialIapAppSlug([], "good"), "");
});
