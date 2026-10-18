import assert from "node:assert/strict";
import test from "node:test";
import {
  issueThreadPayload,
  threadStartFailure,
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

test("쓰레드 생성 권한 부족은 재시도하지 않고 사유를 남긴다", () => {
  const denied = threadStartFailure({
    ok: false,
    error: "Discord HTTP 403: Missing Permissions",
    statusCode: 403,
  });
  assert.equal(denied.terminal, true);
  assert.ok(denied.error!.includes("CREATE_PUBLIC_THREADS"));
});

test("일시적 실패는 재시도 대상으로 남긴다", () => {
  // 429·5xx·네트워크는 기다리면 풀린다. terminal 로 만들면 알림이 사라진다.
  for (const statusCode of [429, 500, 502, undefined]) {
    const result = threadStartFailure({
      ok: false,
      error: "일시 오류",
      statusCode,
    });
    assert.equal(result.terminal, undefined, String(statusCode));
    assert.equal(result.error, "일시 오류");
  }
});
