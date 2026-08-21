import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  claimTeammateRun,
  isUniqueViolation,
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
