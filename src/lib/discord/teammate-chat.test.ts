import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  claimTeammateRun,
  isUniqueViolation,
  mentionDedupeKey,
  teammateSystemPrompt,
  withLlm429Retry,
} from "@/lib/discord/teammate-chat";
import { TEAMMATES } from "@/lib/discord/teammates";

const PROMPT_CONTEXT = {
  portfolio: [
    { id: "1", slug: "happy-farm", displayName: "해피팜", repoFullName: "seorilabs/happy-farm", currentStage: "LIVEOPS" },
  ],
  directory: ["- 노을: happy-farm", "- 이슬: lizard-tycoon"],
};

test("오너 프롬프트에 정체성·포트폴리오·권한·담당자 지목이 들어간다", () => {
  const prompt = teammateSystemPrompt(TEAMMATES.noeul, "앱 10개", PROMPT_CONTEXT);
  assert.ok(prompt.includes('AI 담당자 "노을"'));
  assert.ok(prompt.includes("담당 포트폴리오"));
  assert.ok(prompt.includes("해피팜 (happy-farm)"));
  assert.ok(prompt.includes("릴리즈 승인 판단"));
  assert.ok(prompt.includes("담당자를 지목한다"));
  assert.ok(prompt.includes("- 이슬: lizard-tycoon"));
  assert.ok(prompt.includes("앱 10개"));
  // 배포 트리거는 어떤 오너에게도 없다.
  assert.ok(!prompt.includes("- 배포 실행"));
});

test("운영 총괄 프롬프트는 포트폴리오 대신 횡단 영역을 담는다", () => {
  const prompt = teammateSystemPrompt(TEAMMATES.seori, "현황", { portfolio: [], directory: PROMPT_CONTEXT.directory });
  assert.ok(prompt.includes('운영 총괄 AI "서리"'));
  assert.ok(!prompt.includes("담당 포트폴리오"));
  assert.ok(prompt.includes("운영 장애 확인·분류"));
  assert.ok(prompt.includes("- 노을: happy-farm"));
});

test("멘션 dedupe 키는 메시지와 팀원 조합이다", () => {
  assert.equal(mentionDedupeKey("123", "noeul"), "mention:123:noeul");
});

test("resume replay 로 같은 dedupeKey 가 다시 오면 claim 이 null 로 skip 된다", async () => {
  // Gateway RESUME 은 놓친 이벤트를 재전송하므로 같은 메시지 ID 가 두 번 올 수 있다.
  // teammate_run.dedupeKey unique 위반(P2002)은 이미 처리한 멘션이라는 뜻이다.
  assert.equal(await claimTeammateRun(async () => ({ id: "run-1" })), "run-1");
  assert.equal(
    await claimTeammateRun(async () => {
      throw Object.assign(new Error("Unique constraint failed on dedupeKey"), { code: "P2002" });
    }),
    null,
  );
});

test("unique 위반이 아닌 claim 오류는 그대로 전파된다", async () => {
  await assert.rejects(
    claimTeammateRun(async () => {
      throw new Error("db down");
    }),
    /db down/,
  );
});

test("unique 위반 판별은 P2002 코드만 인정한다", () => {
  const p2002 = Object.assign(new Error("dup"), { code: "P2002" });
  assert.ok(isUniqueViolation(p2002));
  assert.ok(!isUniqueViolation(Object.assign(new Error("other"), { code: "P2025" })));
  assert.ok(!isUniqueViolation(new Error("plain")));
  assert.ok(!isUniqueViolation(null));
});

test("teammate_run dedupeKey 는 스키마에서 unique 로 강제된다", () => {
  // 코드 경로(P2002 skip)와 짝을 이루는 DB 제약. 이 제약이 빠지면 replay 중복
  // 응답을 막을 수 없다.
  const schema = readFileSync(new URL("../../../prisma/schema.prisma", import.meta.url), "utf8");
  assert.match(schema, /dedupeKey\s+String\s+@unique/);
});

test("Gemini 429 는 한 번만 재시도한다", async () => {
  let calls = 0;
  const result = await withLlm429Retry(async () => {
    calls += 1;
    if (calls === 1) throw new Error("Gemini API 요청 실패 (429): quota");
    return "ok";
  }, 1);
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("429 가 아닌 오류는 즉시 던진다", async () => {
  let calls = 0;
  await assert.rejects(
    withLlm429Retry(async () => {
      calls += 1;
      throw new Error("Gemini API 요청 실패 (500): boom");
    }, 1),
    /500/,
  );
  assert.equal(calls, 1);
});

test("재시도까지 429 면 오류를 그대로 던진다", async () => {
  let calls = 0;
  await assert.rejects(
    withLlm429Retry(async () => {
      calls += 1;
      throw new Error("Gemini API 요청 실패 (429): quota");
    }, 1),
    /429/,
  );
  assert.equal(calls, 2);
});

test("멘션 payload 는 필수 식별자가 전부 있어야 파싱된다", async () => {
  const { parseMentionPayload } = await import("@/lib/discord/teammate-chat");
  const full = {
    guildId: "g1",
    channelId: "c1",
    userId: "u1",
    messageId: "m1",
    text: "어제 DAU 알려줘",
  };
  assert.deepEqual(parseMentionPayload(full), full);
  // text 는 빈 멘션(소개 요청)일 수 있어 없어도 된다.
  assert.deepEqual(parseMentionPayload({ ...full, text: undefined }), { ...full, text: "" });
  // 식별자 하나라도 빠지면 재시도 불가 — null 로 실패를 드러낸다.
  assert.equal(parseMentionPayload({ ...full, channelId: "" }), null);
  assert.equal(parseMentionPayload({ ...full, messageId: 123 }), null);
  assert.equal(parseMentionPayload(null), null);
  assert.equal(parseMentionPayload(["not", "object"]), null);
});
