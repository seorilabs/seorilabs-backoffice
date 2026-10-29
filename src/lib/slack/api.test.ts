import test from "node:test";
import assert from "node:assert/strict";
import { slackApi } from "./api";

const response = (body: unknown, status = 200, headers = {}) => async () => new Response(JSON.stringify(body), { status, headers });

test("Slack은 HTTP 200의 ok:false를 실패로 처리한다", async () => {
  const result = await slackApi("chat.postMessage", {}, { token: "test", request: response({ ok: false, error: "missing_scope" }) });
  assert.equal(result.ok, false);
  assert.equal(result.error, "missing_scope");
  assert.equal(result.terminal, true);
});
test("429는 Retry-After를 따르고 신규 게시의 불명확한 실패는 재게시하지 않는다", async () => {
  const limited = await slackApi("chat.postMessage", {}, { token: "test", request: response({ ok: false, error: "ratelimited" }, 429, { "retry-after": "7" }) });
  assert.equal(limited.retryAfterMs, 7000);
  assert.equal(limited.terminal, false);
  const failed = await slackApi("chat.postMessage", {}, { token: "test", request: response({}, 503) });
  assert.equal(failed.error, "SLACK_DELIVERY_OUTCOME_UNKNOWN");
  assert.equal(failed.terminal, true);
  const edit = await slackApi("chat.update", {}, { token: "test", request: response({}, 503) });
  assert.equal(edit.terminal, false);
});
test("응답 유실은 새 게시 성공으로 기록하거나 자동 반복하지 않는다", async () => {
  const request = async () => { throw new Error("secret must never be returned"); };
  const result = await slackApi("chat.postMessage", {}, { token: "test", request });
  assert.equal(result.error, "SLACK_DELIVERY_OUTCOME_UNKNOWN");
  assert.equal(result.terminal, true);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
test("생성 API의 비정상 JSON 응답도 게시 결과 미확정으로 보존한다", async () => {
  for (const body of [null, {}, [], {ok:"true"}]) {
    const result = await slackApi("chat.postMessage",{}, {token:"test",request:response(body)});
    assert.equal(result.error,"SLACK_DELIVERY_OUTCOME_UNKNOWN");
    assert.equal(result.terminal,true);
  }
});
