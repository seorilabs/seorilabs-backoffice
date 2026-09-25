import assert from "node:assert/strict";
import test from "node:test";

import { buildStoreReviewStateEmbed } from "@/lib/notifications/discord-builders/store-review-state";
import { normalizeSubmissionState } from "@/lib/store-reviews/submissions/normalizer";

test("APP_STORE 디스코드 카드는 store 색(blue)을 쓰고 한글 라벨을 표시한다", () => {
  const normalized = normalizeSubmissionState({
    store: "APP_STORE",
    state: "REJECTED",
  });
  const embed = buildStoreReviewStateEmbed({
    appDisplayName: "Happy Farm",
    bundleIdOrPackage: "com.seorilabs.happyfarm",
    versionLabel: "1.2.0",
    normalized,
    sourceEventAt: new Date("2026-09-25T03:00:00Z"),
  });
  assert.equal(embed.color, 0x0a84ff);
  assert.equal(
    embed.title,
    "[App Store] Happy Farm v1.2.0 — 심사 거절",
  );
  assert.equal(embed.description, "✗ 심사 거절");
  const fieldsByName = Object.fromEntries(
    embed.fields.map((field) => [field.name, field.value]),
  );
  assert.equal(fieldsByName["단계"], "심사 거절");
  assert.equal(fieldsByName["스토어"], "App Store");
  assert.equal(fieldsByName["App"], "com.seorilabs.happyfarm");
  assert.equal(embed.footer, undefined);
  assert.equal(embed.timestamp, "2026-09-25T03:00:00.000Z");
});

test("GOOGLE_PLAY 디스코드 카드는 green 색을 쓰고 소제목에 Google Play 배지를 단다", () => {
  const normalized = normalizeSubmissionState({
    store: "GOOGLE_PLAY",
    state: "completed",
  });
  const embed = buildStoreReviewStateEmbed({
    appDisplayName: "Lizard Tycoon",
    bundleIdOrPackage: "com.seorilabs.lizardtycoon",
    versionLabel: "0.4.1",
    normalized,
    sourceEventAt: new Date("2026-09-25T10:00:00Z"),
    appHomeUrl: "https://backoffice.vzyx.xyz/apps/app-id/releases",
  });
  assert.equal(embed.color, 0x34a853);
  assert.equal(
    embed.title,
    "[Google Play] Lizard Tycoon v0.4.1 — 출시 완료",
  );
  assert.equal(embed.description, "✓ 출시 완료");
  assert.deepEqual(embed.footer, {
    text: "https://backoffice.vzyx.xyz/apps/app-id/releases",
  });
});

test("appHomeUrl 을 생략하면 footer 가 없다", () => {
  const normalized = normalizeSubmissionState({
    store: "APP_STORE",
    state: "IN_REVIEW",
  });
  const embed = buildStoreReviewStateEmbed({
    appDisplayName: "Crossword Puzzle",
    bundleIdOrPackage: "com.seorilabs.crosswordpuzzle",
    versionLabel: "3.0.0",
    normalized,
    sourceEventAt: new Date("2026-09-25T01:00:00Z"),
  });
  assert.equal(embed.footer, undefined);
});
