import assert from "node:assert/strict";
import test from "node:test";
import {
  mentionDedupeKey,
  teammateSystemPrompt,
  withGemini429Retry,
} from "@/lib/discord/teammate-chat";
import { TEAMMATES } from "@/lib/discord/teammates";

test("팀원 프롬프트에 정체성·권한·거절 안내가 들어간다", () => {
  const prompt = teammateSystemPrompt(TEAMMATES.qa, "앱 10개");
  assert.ok(prompt.includes("서리 QA"));
  assert.ok(prompt.includes("릴리즈 승인 판단"));
  assert.ok(prompt.includes("권한 밖 요청은 수행하지 말고"));
  assert.ok(prompt.includes("지표 해석·계측 공백: 서리 데이터"));
  assert.ok(prompt.includes("앱 10개"));
});

test("데이터 팀원 프롬프트에는 배포 권한이 없다", () => {
  const prompt = teammateSystemPrompt(TEAMMATES.data, "현황");
  assert.ok(!prompt.includes("- 배포 실행"));
  assert.ok(prompt.includes("지표 이상 확인·해석"));
});

test("멘션 dedupe 키는 메시지와 팀원 조합이다", () => {
  assert.equal(mentionDedupeKey("123", "development"), "mention:123:development");
});

test("Gemini 429 는 한 번만 재시도한다", async () => {
  let calls = 0;
  const result = await withGemini429Retry(async () => {
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
    withGemini429Retry(async () => {
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
    withGemini429Retry(async () => {
      calls += 1;
      throw new Error("Gemini API 요청 실패 (429): quota");
    }, 1),
    /429/,
  );
  assert.equal(calls, 2);
});
