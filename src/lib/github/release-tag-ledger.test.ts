import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReleaseTagWorkflowInputs,
  createStableReleaseTag,
  waitForTagCommitSha,
  RELEASE_TAG_WORKFLOW_FILE,
  type LedgerTagPorts,
} from "@/lib/github/release-tag-ledger";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

interface Recorder {
  dispatched: { workflowFile: string; ref: string; inputs: Record<string, string> }[];
  directCalls: { tag: string; sha: string }[];
}

function ports(
  overrides: Partial<LedgerTagPorts> & { tagShas?: (string | null)[] } = {},
): { ports: LedgerTagPorts; recorder: Recorder } {
  const recorder: Recorder = { dispatched: [], directCalls: [] };
  const tagShas = overrides.tagShas ?? [null, SHA];
  let read = 0;
  const base: LedgerTagPorts = {
    readTagCommitSha: async () => tagShas[Math.min(read++, tagShas.length - 1)],
    readLedgerFile: async () => '{"schemaVersion":1}',
    readDefaultBranch: async () => "main",
    readDispatchContract: async () => ({
      dispatchable: true,
      inputNames: new Set(["bump", "tag", "target_ref", "dry_run"]),
    }),
    dispatch: async (input) => {
      recorder.dispatched.push(input);
    },
    createTagDirect: async (input) => {
      recorder.directCalls.push(input);
      return { created: true };
    },
    sleep: async () => {},
  };
  const { tagShas: _ignored, ...rest } = overrides;
  return { ports: { ...base, ...rest }, recorder };
}

test("원장이 없는 저장소는 기존 직접 생성 경로를 쓴다", async () => {
  const { ports: p, recorder } = ports({ readLedgerFile: async () => null });
  const result = await createStableReleaseTag(p, { tag: "v1.2.3", sha: SHA });
  assert.deepEqual(result, { created: true, path: "direct" });
  assert.deepEqual(recorder.directCalls, [{ tag: "v1.2.3", sha: SHA }]);
  assert.equal(recorder.dispatched.length, 0);
});

test("원장이 있으면 중앙 release-tag.yml 만 태그를 만든다", async () => {
  const { ports: p, recorder } = ports();
  const result = await createStableReleaseTag(p, { tag: "v1.2.3", sha: SHA });
  assert.deepEqual(result, { created: true, path: "ledger-workflow" });
  assert.equal(recorder.directCalls.length, 0);
  assert.deepEqual(recorder.dispatched, [
    {
      workflowFile: RELEASE_TAG_WORKFLOW_FILE,
      ref: "main",
      inputs: { tag: "v1.2.3", target_ref: SHA, dry_run: "false" },
    },
  ]);
});

test("같은 커밋에 태그가 이미 있으면 아무것도 하지 않는다", async () => {
  const { ports: p, recorder } = ports({ tagShas: [SHA] });
  const result = await createStableReleaseTag(p, { tag: "v1.2.3", sha: SHA });
  assert.deepEqual(result, { created: false, path: "existing" });
  assert.equal(recorder.dispatched.length, 0);
  assert.equal(recorder.directCalls.length, 0);
});

test("다른 커밋에 같은 태그가 있으면 거부한다", async () => {
  const { ports: p } = ports({ tagShas: [OTHER_SHA] });
  await assert.rejects(
    createStableReleaseTag(p, { tag: "v1.2.3", sha: SHA }),
    /이미 존재합니다/u,
  );
});

test("원장 저장소인데 release-tag workflow_dispatch 가 없으면 태그를 만들지 않는다", async () => {
  // 여기서 직접 생성으로 폴백하면 receipt 없는 태그가 생겨 배포가 영구히 거부된다.
  const { ports: p, recorder } = ports({
    readDispatchContract: async () => ({ dispatchable: false, inputNames: new Set<string>() }),
  });
  await assert.rejects(
    createStableReleaseTag(p, { tag: "v1.2.3", sha: SHA }),
    /workflow_dispatch 가 없습니다/u,
  );
  assert.equal(recorder.directCalls.length, 0);
  assert.equal(recorder.dispatched.length, 0);
});

test("선언된 입력만 채운다", () => {
  assert.deepEqual(
    buildReleaseTagWorkflowInputs(new Set(["bump", "tag", "target_ref"]), {
      tag: "v2.0.0",
      targetRef: SHA,
    }),
    { tag: "v2.0.0", target_ref: SHA },
  );
});

test("tag·target_ref 를 선언하지 않은 caller 는 거부한다", () => {
  assert.throws(
    () => buildReleaseTagWorkflowInputs(new Set(["bump"]), { tag: "v2.0.0", targetRef: SHA }),
    /tag 입력을 선언하지 않았습니다/u,
  );
  assert.throws(
    () => buildReleaseTagWorkflowInputs(new Set(["tag"]), { tag: "v2.0.0", targetRef: SHA }),
    /target_ref 입력을 선언하지 않았습니다/u,
  );
});

test("태그가 늦게 보여도 기다렸다가 성공한다", async () => {
  const observed = [null, null, SHA];
  let index = 0;
  await waitForTagCommitSha(async () => observed[index++], { tag: "v1.2.3", sha: SHA }, {
    delaysMs: [1, 1, 1],
    sleep: async () => {},
  });
  assert.equal(index, 3);
});

test("기다려도 태그가 없으면 실행 확인 안내로 멈춘다", async () => {
  await assert.rejects(
    waitForTagCommitSha(async () => null, { tag: "v1.2.3", sha: SHA }, {
      delaysMs: [1, 1],
      sleep: async () => {},
    }),
    /Release Tag 실행 결과를 확인하세요/u,
  );
});

test("워크플로우가 다른 커밋에 태그를 붙이면 실패한다", async () => {
  await assert.rejects(
    waitForTagCommitSha(async () => OTHER_SHA, { tag: "v1.2.3", sha: SHA }, {
      delaysMs: [1],
      sleep: async () => {},
    }),
    /요청한 커밋/u,
  );
});
