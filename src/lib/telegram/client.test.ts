import assert from "node:assert/strict";
import test from "node:test";
import {
  telegramResponseOk,
  telegramRetryDelayMs,
} from "@/lib/telegram/client";

test("Telegram 성공 응답만 전송 성공으로 판정한다", () => {
  assert.equal(telegramResponseOk({ ok: true }), true);
  assert.equal(telegramResponseOk({ ok: false, error_code: 400 }), false);
  assert.equal(telegramResponseOk(null), false);
});

test("429와 5xx 및 네트워크 오류만 제한 재시도한다", () => {
  assert.equal(
    telegramRetryDelayMs(
      { ok: false, error_code: 429, parameters: { retry_after: 3 } },
      0,
    ),
    3_000,
  );
  assert.equal(telegramRetryDelayMs({ ok: false, error_code: 502 }, 1), 500);
  assert.equal(telegramRetryDelayMs({ ok: false, error_code: 400 }, 0), null);
  assert.equal(telegramRetryDelayMs(null, 2), 1_000);
});
