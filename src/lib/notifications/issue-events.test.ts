import assert from "node:assert/strict";
import test from "node:test";
import { issueEventMessage, issueUrl } from "@/lib/notifications/issue-events";

test("생성 알림은 P1 을 계속 구분하고 링크를 건다", () => {
  assert.equal(
    issueEventMessage({
      action: "opened",
      repoFullName: "seorilabs/happy-farm",
      number: 466,
      title: "Android 튜토리얼 완주 13%",
      priority: "P1",
    }),
    "🔥 **새 P1** · P1\n" +
      "[happy-farm #466 Android 튜토리얼 완주 13%](https://github.com/seorilabs/happy-farm/issues/466)",
  );
  assert.match(
    issueEventMessage({
      action: "opened",
      repoFullName: "seorilabs/happy-farm",
      number: 467,
      title: "reward 단계 정체",
      priority: "P3",
    }),
    /^🆕 \*\*새 이슈\*\* · P3\n/,
  );
});

test("라벨 없는 이슈도 알림 대상이며 등급 뱃지만 빠진다", () => {
  const text = issueEventMessage({
    action: "opened",
    repoFullName: "seorilabs/platform",
    number: 7,
    title: "outbox 재발행",
    priority: null,
  });
  assert.equal(
    text,
    "🆕 **새 이슈**\n[platform #7 outbox 재발행](https://github.com/seorilabs/platform/issues/7)",
  );
});

test("종료 알림은 사유별로 문구가 갈리고 사유가 비면 처리완료로 본다", () => {
  const base = {
    action: "closed" as const,
    repoFullName: "seorilabs/crossword-puzzle",
    number: 352,
    title: "RN 복귀알림 전무",
    priority: "P2" as const,
  };
  assert.match(issueEventMessage({ ...base, stateReason: "completed" }), /^✅ \*\*처리완료\*\* · P2\n/);
  assert.match(issueEventMessage({ ...base, stateReason: "not_planned" }), /^🚫 \*\*미진행 종료\*\*/);
  assert.match(issueEventMessage({ ...base, stateReason: "duplicate" }), /^♻️ \*\*중복 종료\*\*/);
  assert.match(issueEventMessage({ ...base, stateReason: null }), /^✅ \*\*처리완료\*\*/);
});

test("제목의 대괄호는 링크 문법을 깨뜨리므로 제거하고 길이를 제한한다", () => {
  const text = issueEventMessage({
    action: "closed",
    repoFullName: "seorilabs/jomul",
    number: 12,
    title: `[P1] ${"가".repeat(200)}`,
    priority: null,
    stateReason: "completed",
  });
  const link = text.split("\n")[1];
  assert.equal(link.startsWith("[jomul #12 P1 "), true);
  assert.equal(link.endsWith("](https://github.com/seorilabs/jomul/issues/12)"), true);
  assert.equal(link.includes("]("), true);
  // 제목 본문은 120자로 잘린다.
  assert.equal(link.slice("[jomul #12 ".length, -"](https://github.com/seorilabs/jomul/issues/12)".length).length, 120);
});

test("이슈 링크는 repo full name 으로 결정적으로 만든다", () => {
  assert.equal(issueUrl("seorilabs/matgo", 16), "https://github.com/seorilabs/matgo/issues/16");
});
