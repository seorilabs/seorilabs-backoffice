import assert from "node:assert/strict";
import test from "node:test";
import {
  issueThreadPayload,
} from "@/lib/notifications/issue-thread";

test("쓰레드 payload 는 필수 필드가 다 있을 때만 인식된다", () => {
  const valid = {
    text: "본문",
    thread: { parentDedupeKey: "k", threadName: "n" },
  };
  assert.deepEqual(issueThreadPayload(valid), {
    text: "본문",
    parentDedupeKey: "k",
    threadName: "n",
    plain: true,
  });
  // 일반 알림 payload 가 쓰레드로 오인되면 안 된다.
  for (const invalid of [
    null,
    { text: "본문" },
    { text: "본문", thread: {} },
    { text: "", thread: { parentDedupeKey: "k", threadName: "n" } },
    { thread: { parentDedupeKey: "k", threadName: "n" } },
  ]) {
    assert.equal(
      issueThreadPayload(invalid as never),
      null,
      JSON.stringify(invalid),
    );
  }
});

test("외부 리뷰 로그 쓰레드는 embed 본문과 원문 첨부를 보존한다", () => {
  const payload = issueThreadPayload({
    text: "MiniMax 응답 원문",
    thread: {
      parentDedupeKey: "external:seori-pr-bot:root",
      threadName: "PR #47",
      plain: false,
    },
    attachment: {
      filename: "minimax-response.json",
      contentType: "application/json",
      base64: "eyJvayI6dHJ1ZX0=",
    },
  });

  assert.deepEqual(payload, {
    text: "MiniMax 응답 원문",
    parentDedupeKey: "external:seori-pr-bot:root",
    threadName: "PR #47",
    plain: false,
    attachment: {
      filename: "minimax-response.json",
      contentType: "application/json",
      base64: "eyJvayI6dHJ1ZX0=",
    },
  });
});
