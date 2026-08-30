import assert from "node:assert/strict";
import test from "node:test";
import {
  issueClosedThreadText,
  issueOpenedThreadText,
  issueThreadName,
  issueThreadPayload,
  planIssueThread,
  type IssueThreadDeps,
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

// ── 게시 계획 ────────────────────────────────────────────────────────────────

function deps(
  overrides: Partial<Omit<IssueThreadDeps, "findOpenedThreadKey">> & { openedKey?: string | null } = {},
): IssueThreadDeps & { lookups: string[] } {
  const lookups: string[] = [];
  const { openedKey = null, ...rest } = overrides;
  return {
    lookups,
    // 조회 인자를 기록해 "생성은 조회하지 않는다"를 검증할 수 있게 한다.
    findOpenedThreadKey: async (name) => {
      lookups.push(name);
      return openedKey;
    },
    listComments: async () => [],
    listLinkedPulls: async () => [],
    ...rest,
  };
}

const OPENED = {
  action: "opened" as const,
  parentDedupeKey: "github:d1:issue-opened",
  repo: "happy-farm",
  number: 466,
  title: "튜토리얼 완주 13%",
};

test("생성은 부모 존재를 확인하지 않고 바로 예약한다", async () => {
  // 부모가 같은 요청에서 막 enqueue 되므로 아직 SENT 가 아니다. 여기서 막으면
  // 생성 쓰레드가 영영 안 붙는다.
  const d = deps();
  const plan = await planIssueThread({ ...OPENED, body: "본문" }, d);
  assert.deepEqual(plan, {
    dedupeKey: "github:d1:issue-opened:thread",
    text: "본문",
    parentDedupeKey: "github:d1:issue-opened",
    threadName: "happy-farm #466 튜토리얼 완주 13%",
  });
  assert.deepEqual(d.lookups, [], "생성은 부모를 조회하지 않는다");
});

test("종료는 생성 알림 메시지의 쓰레드에 붙는다", async () => {
  const plan = await planIssueThread(
    { ...OPENED, action: "closed", parentDedupeKey: "github:d2:issue-closed", stateReason: "completed" },
    deps({
      openedKey: "github:d1:issue-opened:thread",
      listComments: async () => [{ author: "magicsih", body: "확인" }],
    }),
  );
  // 종료 메시지가 아니라 생성 메시지가 부모다 — 한 이슈의 맥락이 한 쓰레드에 모인다.
  assert.equal(plan!.parentDedupeKey, "github:d1:issue-opened");
  assert.equal(plan!.dedupeKey, "github:d2:issue-closed:thread");
  assert.ok(plan!.text.includes("확인"));
});

test("도입 전에 열린 이슈의 종료는 예약 자체를 건너뛴다", async () => {
  // 부모가 영영 안 생기므로 enqueue 하면 매일 dead letter 가 쌓인다.
  const d = deps({ openedKey: null, listComments: async () => [{ author: "a", body: "b" }] });
  const plan = await planIssueThread(
    { ...OPENED, action: "closed", parentDedupeKey: "github:d2:issue-closed" },
    d,
  );
  assert.equal(plan, null);
  assert.deepEqual(d.lookups, ["happy-farm #466 튜토리얼 완주 13%"]);
});

test("부모가 있어도 붙일 맥락이 없으면 예약하지 않는다", async () => {
  const plan = await planIssueThread(
    { ...OPENED, action: "closed", parentDedupeKey: "github:d2:issue-closed" },
    deps({ openedKey: "github:d1:issue-opened:thread" }),
  );
  assert.equal(plan, null);
});

test("댓글 조회가 실패해도 PR 링크만으로 쓰레드를 남긴다", async () => {
  // 배선(webhook)이 실패를 빈 배열로 흘려보내므로 계획 단계는 PR 만으로 성립해야 한다.
  const plan = await planIssueThread(
    { ...OPENED, action: "closed", parentDedupeKey: "github:d2:issue-closed" },
    deps({
      openedKey: "github:d1:issue-opened:thread",
      listComments: async () => [],
      listLinkedPulls: async () => [
        { number: 7, title: "fix", url: "https://github.com/seorilabs/happy-farm/pull/7", merged: true },
      ],
    }),
  );
  assert.ok(plan!.text.includes("머지됨 [#7 fix]"));
  assert.ok(!plan!.text.includes("댓글"));
});
