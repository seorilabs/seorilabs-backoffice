import assert from "node:assert/strict";
import test from "node:test";
import { issueEventReport, issueUrl } from "./issue-events";
const base = {
  action: "opened" as const,
  repoFullName: "seorilabs/happy-farm",
  appName: "행복 농장",
  number: 466,
  title: "Android 튜토리얼 완주 13%",
  priority: "P1" as const,
  updatedAt: "2026-10-17T14:00:00Z",
};
test("중요 개발 사건은 앱과 결론·이슈 근거를 먼저 보이고 일반 상태는 내부 기록", () => {
  const report = issueEventReport(base);
  assert.equal(report.payload.report.category, "change");
  assert.match(
    report.payload.text,
    /^\*\*행복 농장 · 우선 처리할 문제가 등록됐습니다\.\*\*/,
  );
  assert.match(report.payload.text, /Android 튜토리얼 완주 13%/);
  assert.match(
    report.payload.text,
    /https:\/\/github.com\/seorilabs\/happy-farm\/issues\/466/,
  );
  for (const priority of ["P2", "P3", null] as const)
    assert.equal(
      issueEventReport({ ...base, priority }).payload.report.category,
      "internal",
    );
});
test("같은 GitHub 사건은 delivery ID와 관계없는 키이고 재개 후 새 종료는 구별", () => {
  const first = issueEventReport(base);
  assert.equal(first.dedupeKey, issueEventReport({ ...base }).dedupeKey);
  assert.notEqual(
    first.dedupeKey,
    issueEventReport({ ...base, action: "closed" }).dedupeKey,
  );
  assert.notEqual(
    first.dedupeKey,
    issueEventReport({ ...base, updatedAt: "2026-10-18T14:00:00Z" }).dedupeKey,
  );
});
test("GitHub 종료 기록을 사용자 문제의 실제 복구로 추정하지 않는다", () => {
  const done = issueEventReport({
    ...base,
    action: "closed",
    stateReason: "completed",
  }).payload.text;
  assert.match(done, /우선 처리 항목을 완료로 닫았습니다/);
  assert.doesNotMatch(done, /복구 확인|서비스 정상/);
  assert.match(
    issueEventReport({ ...base, action: "closed", stateReason: "not_planned" })
      .payload.text,
    /미진행/,
  );
  assert.match(
    issueEventReport({ ...base, action: "closed", stateReason: "duplicate" })
      .payload.text,
    /중복/,
  );
});
test("긴 제목과 대괄호가 근거 링크를 깨지 않으며 링크는 GitHub 정본을 가리킨다", () => {
  const report = issueEventReport({
    ...base,
    title: `[P1] ${"가".repeat(200)}`,
  });
  assert.equal(
    issueUrl(base.repoFullName, base.number),
    "https://github.com/seorilabs/happy-farm/issues/466",
  );
  assert.ok(
    report.payload.text.includes(
      "](https://github.com/seorilabs/happy-farm/issues/466)",
    ),
  );
  assert.ok(!report.payload.text.includes("[P1]"));
  assert.ok(report.payload.text.length < 400);
});
