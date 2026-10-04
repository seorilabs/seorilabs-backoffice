import assert from "node:assert/strict";
import test from "node:test";
import { remindersAllowed, providerError, validateTarget } from "./policy";
const sha = "a".repeat(40), imageSha = "b".repeat(40);
const run = { id: 10, run_attempt: 2, head_sha: sha, path: ".github/workflows/deploy-staging.yml" };
const target = { version: 1, repository: "seorilabs/platform", runId: "10", runAttempt: 2, sourceSha: sha, imageSha, environment: "staging", workflow: "deploy-staging.yml", image: `asia-northeast3-docker.pkg.dev/seorilabs-platform/platform/platform:${imageSha}`, targets: ["cloud-run:seorilabs-platform:asia-northeast3:platform-api-stg"] };
test("staging 소스 SHA와 이미지 SHA를 별도로 고정", () => { assert.equal(validateTarget(target, run, "staging").imageSha, imageSha); });
test("재실행·환경·소스·이미지·대상·workflow 불일치 차단", () => {
  for (const patch of [{ runAttempt: 1 }, { runId: "11" }, { sourceSha: imageSha }, { environment: "production" }, { image: "other:tag" }, { targets: ["production"] }, { workflow: "deploy.yml" }]) assert.throws(() => validateTarget({ ...target, ...patch }, run, "staging"));
});
test("KST 22시부터 재알림 중단하고 09시에 재개", () => {
  for (const [date, expected] of [["2026-10-04T12:59:00Z", true], ["2026-10-04T13:00:00Z", false], ["2026-10-04T23:59:00Z", false], ["2026-10-05T00:00:00Z", true]] as const) assert.equal(remindersAllowed(new Date(date)), expected);
});
test("토큰 만료·권한 부족을 구분하고 원문 토큰은 출력하지 않음", () => {
  assert.match(providerError({ status: 401, message: "github_pat_secret" }), /만료/);
  assert.match(providerError({ status: 403 }), /권한/);
  assert.doesNotMatch(providerError(new Error("github_pat_secret")), /github_pat/);
});

test("최초 30분, 이후 2시간 재알림과 밤사이 누적 합치기", async () => {
  const { reminderDue } = await import("./policy");
  const first = new Date("2026-10-04T01:00:00Z");
  const row = { initialNotifiedAt: first, nextReminderAt: null };
  assert.equal(reminderDue(row, new Date("2026-10-04T01:29:59Z"), false), false);
  assert.equal(reminderDue(row, new Date("2026-10-04T01:30:00Z"), false), true);
  const next = { ...row, nextReminderAt: new Date("2026-10-04T03:30:00Z") };
  assert.equal(reminderDue(next, new Date("2026-10-04T03:29:59Z"), false), false);
  assert.equal(reminderDue(next, new Date("2026-10-04T03:30:00Z"), false), true);
  assert.equal(reminderDue(next, new Date("2026-10-05T00:00:00Z"), true), false, "밤사이 미발송 항목과 새 재알림이 겹치지 않음");
  assert.equal(reminderDue(next, new Date("2026-10-05T00:00:00Z"), false), true);
  assert.equal(reminderDue({ ...row, initialNotifiedAt: null }, first, false), false);
});

test("worker 복구는 명령 ID·승인자·환경·결정이 일치하는 GitHub 이력만 인정", async () => {
  const { reviewMatches } = await import("./policy");
  const expected = { commandId: "command1", githubId: "1", environmentId: "20", decision: "approved" };
  const review = { comment: "backoffice:command1\n승인합니다", state: "approved", user: { id: 1 }, environments: [{ id: 20 }] };
  assert.equal(reviewMatches(review, expected), true);
  for (const patch of [{ comment: "backoffice:old-command" }, { state: "rejected" }, { user: { id: 2 } }, { environments: [{ id: 21 }] }]) assert.equal(reviewMatches({ ...review, ...patch }, expected), false);
});
