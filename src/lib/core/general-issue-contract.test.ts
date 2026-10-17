import assert from "node:assert/strict";
import test from "node:test";
import { parseGeneralIssueOutput, validateGeneralIssueText, generalIssuePrompt } from "./general-issue-contract";

test("일반 요청은 원문에 근거한 제목·본문만 만들고 길이를 자르지 않는다", () => {
  assert.deepEqual(parseGeneralIssueOutput('{"title":"설정 조사","body":"## 요청\\n설정을 조사한다."}'), { title: "설정 조사", body: "## 요청\n설정을 조사한다." });
  for (const value of ["{}", "잘린 출력", JSON.stringify({ title: "x".repeat(121), body: "요청" }), JSON.stringify({ title: "요청", body: "x".repeat(4001) })]) {
    assert.throws(() => parseGeneralIssueOutput(value));
  }
  assert.throws(() => validateGeneralIssueText(" ", "요청"));
  assert.throws(() => validateGeneralIssueText("요청", " "));
  assert.equal(validateGeneralIssueText("x".repeat(120), "x".repeat(4000)).body.length, 4000);
  const prompt = generalIssuePrompt("앱", "seorilabs/app", "설정 조사");
  assert.match(prompt.system, /없는 사실/);
  assert.match(prompt.prompt, /설정 조사/);
});
