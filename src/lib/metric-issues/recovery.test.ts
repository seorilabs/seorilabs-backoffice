import test from "node:test";
import assert from "node:assert/strict";
import { recoverRegistrationAttempts } from "./recovery";
const intent = { repository: "seorilabs/example", appId: "app", marker: "metric-issue:one", title: "제목", body: "본문", labels: ["autopilot"] };
test("이미 확인된 생성·명확한 POST 거절은 재조회 없이 복구를 마친다", async () => {
  for (const payload of [{ marker: intent.marker, status: "registered" }, { marker: intent.marker, status: "needs_input", rejectedStatus: 403 }]) {
    assert.equal(await recoverRegistrationAttempts([{ type: "METRIC_ISSUE_ATTEMPT", payload: intent }, { type: "METRIC_ISSUE_RESULT", payload }], {
      find: async () => { throw Error("확인된 이슈의 후속 편집·보관은 복구를 막지 않는다"); }, confirm: async () => { throw Error("재확인 불필요"); },
    }), true);
  }
});
test("미확인 시도는 본문·라벨이 확인될 때만 복구하며 새 POST는 없다", async () => {
  let confirmed = 0;
  const events = [{ type: "METRIC_ISSUE_ATTEMPT", payload: intent }];
  assert.equal(await recoverRegistrationAttempts(events, { find: async () => undefined, confirm: async () => { confirmed++; } }), false);
  assert.equal(await recoverRegistrationAttempts(events, { find: async () => ({ ...intent, number: 1, state: "open", url: "https://github.com/seorilabs/example/issues/1" }), confirm: async () => { confirmed++; } }), true);
  assert.equal(confirmed, 1);
});

test("다른 시도의 등록 결과나 사전 연결 결과가 현재 POST의 확정을 대신하지 못한다", async () => {
  let reads = 0;
  const events = [{ type: "METRIC_ISSUE_ATTEMPT", payload: { ...intent, attemptId: "run:attempt:new" } },
    { type: "METRIC_ISSUE_RESULT", payload: { marker: intent.marker, status: "linked" } },
    { type: "METRIC_ISSUE_RESULT", payload: { marker: intent.marker, attemptId: "other:attempt", status: "registered" } }];
  assert.equal(await recoverRegistrationAttempts(events, { find: async () => { reads++; return undefined; }, confirm: async () => {} }), false);
  assert.equal(reads, 1);
});
