import assert from "node:assert/strict";
import test from "node:test";
import {
  issueClosedThreadText,
  issueOpenedThreadText,
  issueThreadName,
  issueThreadPayload,
} from "@/lib/notifications/issue-thread";

test("쓰레드 이름은 100자 안에서 이슈 번호를 반드시 남긴다", () => {
  const name = issueThreadName("happy-farm", 466, "가".repeat(200));
  assert.equal(name.length, 100);
  assert.ok(name.startsWith("happy-farm #466 "));
});

test("본문의 마커 주석은 사람에게 의미가 없어 걷어낸다", () => {
  // autopilot 이 남기는 <!-- bo:req=... --> 같은 마커가 그대로 노출되면 안 된다.
  const text = issueOpenedThreadText("실제 본문\n<!-- bo:req=abc -->\n계속");
  assert.ok(!text.includes("bo:req"));
  assert.ok(text.includes("실제 본문"));
});

test("본문이 없어도 쓰레드는 연다", () => {
  // 종료 시 붙일 댓글·PR 이 갈 곳이 필요하다.
  for (const body of [null, undefined, "", "   ", "<!-- only marker -->"]) {
    assert.equal(issueOpenedThreadText(body), "_본문 없음_", String(body));
  }
});

test("긴 본문은 잘라도 잘렸다는 표시를 남긴다", () => {
  const text = issueOpenedThreadText("가".repeat(3000));
  assert.ok(text.endsWith("…"));
  assert.ok(text.length <= 1_201);
});

test("종료 쓰레드는 PR 과 댓글을 함께 싣고 머지 여부를 구분한다", () => {
  const text = issueClosedThreadText({
    stateReason: "completed",
    comments: [{ author: "magicsih", body: "확인했습니다" }],
    pulls: [
      { number: 12, title: "fix: 저장 경로", url: "https://github.com/seorilabs/x/pull/12", merged: true },
      { number: 13, title: "wip", url: "https://github.com/seorilabs/x/pull/13", merged: false },
    ],
  });
  assert.ok(text!.startsWith("✅ 처리완료"));
  assert.ok(text!.includes("머지됨 [#12 fix: 저장 경로](https://github.com/seorilabs/x/pull/12)"));
  assert.ok(text!.includes("미머지 [#13 wip]"));
  assert.ok(text!.includes("**댓글 1건**"));
  assert.ok(text!.includes("**magicsih**: 확인했습니다"));
});

test("붙일 맥락이 하나도 없으면 쓰레드에 아무것도 남기지 않는다", () => {
  // 빈 "처리완료" 한 줄만 쓰레드에 남기면 소음이다. 채널 메시지가 이미 그 사실을 알린다.
  assert.equal(issueClosedThreadText({ stateReason: "completed", comments: [], pulls: [] }), null);
});

test("종료 사유가 채널 메시지와 같은 어휘를 쓴다", () => {
  const base = { comments: [{ author: "a", body: "b" }], pulls: [] };
  assert.ok(issueClosedThreadText({ ...base, stateReason: "not_planned" })!.startsWith("🚫 미진행 종료"));
  assert.ok(issueClosedThreadText({ ...base, stateReason: "duplicate" })!.startsWith("♻️ 중복 종료"));
  assert.ok(issueClosedThreadText({ ...base, stateReason: null })!.startsWith("✅ 처리완료"));
});

test("댓글이 많으면 앞부분만 싣고 남은 건수를 밝힌다", () => {
  const comments = Array.from({ length: 12 }, (_, i) => ({ author: `u${i}`, body: `c${i}` }));
  const text = issueClosedThreadText({ stateReason: "completed", comments, pulls: [] })!;
  assert.ok(text.includes("**댓글 12건**"));
  assert.ok(text.includes("… 외 4건"));
  assert.ok(!text.includes("u8"));
});

test("쓰레드 payload 는 필수 필드가 다 있을 때만 인식된다", () => {
  const valid = { text: "본문", thread: { parentDedupeKey: "k", threadName: "n" } };
  assert.deepEqual(issueThreadPayload(valid), { text: "본문", parentDedupeKey: "k", threadName: "n" });
  // 일반 알림 payload 가 쓰레드로 오인되면 안 된다.
  for (const invalid of [
    null,
    { text: "본문" },
    { text: "본문", thread: {} },
    { text: "", thread: { parentDedupeKey: "k", threadName: "n" } },
    { thread: { parentDedupeKey: "k", threadName: "n" } },
  ]) {
    assert.equal(issueThreadPayload(invalid as never), null, JSON.stringify(invalid));
  }
});
