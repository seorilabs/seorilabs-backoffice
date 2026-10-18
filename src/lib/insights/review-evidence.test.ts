import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveReportEvidence } from "./review-evidence";
import { validatedEvidence } from "./contract";
test("리뷰의 긴 영문과 비밀값 후보를 가리고 분석·상세 화면이 같은 안전한 근거를 쓴다", async () => {
  const body = "lo" + "o".repeat(35) + "ve";
  const facts = await resolveReportEvidence(
    "review-themes",
    [
      {
        id: "review_0",
        label: "리뷰",
        value: "event1",
        source: "App Store · KR",
      },
    ],
    {
      notificationEvent: {
        findMany: async () => [{ id: "event1", payload: { review: { body } } }],
      },
    } as never,
  );
  assert.equal(facts.length, 1);
  assert.ok(!facts[0].value.includes(body));
  assert.match(facts[0].value, /REDACTED/);
  assert.doesNotThrow(() => validatedEvidence(facts));
});
