import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewOptions } from "./options";

test("기본 수집과 명시한 두 리뷰의 복구 인자를 읽는다", () => {
  assert.deepEqual(parseReviewOptions([]), {});
  assert.deepEqual(parseReviewOptions([
    "--app", "bloomhand", "--store", "GOOGLE_PLAY",
    "--notify-review", "one", "--notify-review", "two",
  ]), { appSlug: "bloomhand", store: "GOOGLE_PLAY", notifyReviewIds: ["one", "two"] });
});

test("잘못된 값과 중복과 범위 없는 복구를 거부한다", () => {
  for (const args of [
    ["--unknown", "one"], ["--app"], ["--app", "--store"],
    ["--app", "one", "--app", "two"],
    ["--store", "GOOGLE_PLAY", "--store", "APP_STORE"],
    ["--store", "play"], ["--notify-review", "one"],
    ["--app", "one", "--notify-review", "two"],
  ]) assert.throws(() => parseReviewOptions(args));
});
