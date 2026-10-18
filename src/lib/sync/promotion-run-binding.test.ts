import assert from "node:assert/strict";
import test from "node:test";
import { resolvePromotionRunBinding } from "./promotion-run-binding";

const repo = "seorilabs/bloomhand";
const tag = "v1.0.2";
const sha = "1".repeat(40);
const row = { entityId: `${repo}@${tag}`, payload: { target: "PLAY", to: "production", tag, sha, workflowRunId: "1234" } };

test("다른 태그나 태그 없는 제어 HEAD에서도 실제 승격 실행 ID의 태그와 SHA를 쓴다", async () => {
  for (const status of ["queued", "in_progress", "completed"]) {
    for (const headSha of ["2".repeat(40), "3".repeat(40)]) {
      const result = await resolvePromotionRunBinding(repo, { id: 1234, head_branch: "stable-control", head_sha: headSha, status }, {
        readAudit: async () => [row],
        resolveTag: async () => { throw new Error("제어 HEAD로 태그를 추측하면 안 됨"); },
      });
      assert.deepEqual(result, { version: tag, commitSha: sha });
    }
  }
});

test("결합이 없거나 다른 실행·저장소·태그·SHA이면 결과를 추측하지 않는다", async () => {
  for (const rows of [[], [{ ...row, entityId: "seorilabs/other@v1.0.2" }],
    [{ ...row, payload: { ...row.payload, workflowRunId: "5678" } }],
    [{ ...row, payload: { ...row.payload, tag: "v1.0.3" } }],
    [{ ...row, payload: { ...row.payload, sha: "invalid" } }],
    [row, { ...row, payload: { ...row.payload, sha: "2".repeat(40) } }],
  ]) {
    assert.equal(await resolvePromotionRunBinding(repo, { id: 1234, head_branch: "main", head_sha: "2".repeat(40) }, {
      readAudit: async () => rows, resolveTag: async () => { throw new Error("추측 금지"); },
    }), null);
  }
});

test("감사보다 webhook이 먼저 와도 이후 reconcile에서 같은 실행을 정확히 복원한다", async () => {
  const run = { id: 1234, head_branch: "main" };
  let ready = false;
  const ports = { readAudit: async () => ready ? [row] : [], resolveTag: async () => sha };
  assert.equal(await resolvePromotionRunBinding(repo, run, ports), null);
  ready = true;
  assert.deepEqual(await resolvePromotionRunBinding(repo, run, ports), { version: tag, commitSha: sha });
});

test("기존 태그 ref 승격은 그 태그의 실제 SHA를 유지한다", async () => {
  assert.deepEqual(await resolvePromotionRunBinding(repo, { id: 1234, head_branch: tag }, {
    readAudit: async () => [], resolveTag: async (_repo, actualTag) => { assert.equal(actualTag, tag); return sha; },
  }), { version: tag, commitSha: sha });
});
