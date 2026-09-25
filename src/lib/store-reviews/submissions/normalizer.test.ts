import assert from "node:assert/strict";
import test from "node:test";

import {
  STORE_COLOR_HEX,
  STORE_NAME,
  normalizeSubmissionState,
} from "@/lib/store-reviews/submissions/normalizer";

test("APP_STORE 상태가 한글 라벨과 이모지로 정규화된다", () => {
  const table: ReadonlyArray<readonly [string, string, "…" | "⟳" | "✓" | "✗" | "⏹"]> =
    [
      ["PREPROCESSING", "사전 검토", "…"],
      ["IN_REVIEW", "심사 중", "⟳"],
      ["REJECTED", "심사 거절", "✗"],
      ["APPROVED", "심사 통과", "✓"],
      ["READY_FOR_SALE", "출시 가능", "✓"],
      ["DEVELOPER_REJECTED", "개발자 회수", "⏹"],
      ["DEVELOPER_REMOVED_FROM_SALE", "스토어에서 회수", "⏹"],
    ];
  for (const [state, label, emoji] of table) {
    const normalized = normalizeSubmissionState({
      store: "APP_STORE",
      state,
    });
    assert.equal(normalized.stateLabel, label);
    assert.equal(normalized.emoji, emoji);
    assert.equal(normalized.store, "APP_STORE");
    assert.equal(normalized.storeColorHex, STORE_COLOR_HEX.APP_STORE);
  }
});

test("GOOGLE_PLAY 상태가 한글 라벨과 이모지로 정규화된다", () => {
  const table: ReadonlyArray<readonly [string, string, "…" | "⟳" | "✓" | "✗" | "⏹"]> =
    [
      ["completed", "출시 완료", "✓"],
      ["inProgress", "단계별 출시 중", "⟳"],
      ["halted", "출시 보류", "✗"],
      ["draft", "작성 중", "…"],
    ];
  for (const [state, label, emoji] of table) {
    const normalized = normalizeSubmissionState({
      store: "GOOGLE_PLAY",
      state,
    });
    assert.equal(normalized.stateLabel, label);
    assert.equal(normalized.emoji, emoji);
    assert.equal(normalized.store, "GOOGLE_PLAY");
    assert.equal(normalized.storeColorHex, STORE_COLOR_HEX.GOOGLE_PLAY);
  }
});

test("단계별 출시 비율은 같은 한국어 단계로 표시한다", () => {
  assert.equal(
    normalizeSubmissionState({ store: "GOOGLE_PLAY", state: "inProgress:0.5" }).stateLabel,
    "단계별 출시 중",
  );
});

test("알 수 없는 state는 throw 한다", () => {
  assert.throws(
    () =>
      normalizeSubmissionState({
        store: "APP_STORE",
        state: "UNKNOWN_STATE",
      }),
    /알 수 없는 APP_STORE state: UNKNOWN_STATE/,
  );
});

test("STORE_NAME/STORE_COLOR_HEX가 결정적이다", () => {
  assert.equal(STORE_NAME.APP_STORE, "App Store");
  assert.equal(STORE_NAME.GOOGLE_PLAY, "Google Play");
  assert.equal(STORE_COLOR_HEX.APP_STORE, 0x0a84ff);
  assert.equal(STORE_COLOR_HEX.GOOGLE_PLAY, 0x34a853);
});
