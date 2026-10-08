import assert from "node:assert/strict";
import test from "node:test";
import { exactDraftRegistration } from "./draft-registration";
const input = { repoFullName: "seorilabs/test", draftId: "draft" },
  row = {
    number: 5,
    html_url: "https://github.com/seorilabs/test/issues/5",
    body: "body\n<!-- backoffice-draft:draft -->",
  };
test("등록 결과 확인은 정확한 초안 표식·저장소·이슈를 검증하고 중복은 거부함", () => {
  assert.deepEqual(exactDraftRegistration([row], input), { issueNumber: 5, url: row.html_url });
  assert.equal(
    exactDraftRegistration([{ ...row, body: "<!-- backoffice-draft:draft-other -->" }], input),
    null,
  );
  assert.throws(() => exactDraftRegistration([row, row], input));
  assert.throws(() =>
    exactDraftRegistration([{ ...row, html_url: "https://github.com/other/test/issues/5" }], input),
  );
  assert.deepEqual(
    exactDraftRegistration([{ ...row, html_url: row.html_url + "#issuecomment-123" }], {
      ...input,
      issueNumber: 5,
    }),
    { issueNumber: 5, url: row.html_url + "#issuecomment-123" },
  );
});
