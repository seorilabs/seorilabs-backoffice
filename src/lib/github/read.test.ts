import assert from "node:assert/strict";
import test from "node:test";

import { parseWorkflowDispatchContract } from "@/lib/github/workflow-dispatch";

test("workflow_dispatch가 입력 없이 선언돼도 dispatch 가능하다", () => {
  const contract = parseWorkflowDispatchContract("on:\n  workflow_dispatch:\n");
  assert.equal(contract.dispatchable, true);
  assert.deepEqual([...contract.inputNames], []);
});

test("workflow_dispatch 입력 이름을 읽고 push-only workflow를 구분한다", () => {
  const dispatch = parseWorkflowDispatchContract(`
on:
  workflow_dispatch:
    inputs:
      memo:
        type: string
      create_release_tag:
        type: boolean
`);
  assert.equal(dispatch.dispatchable, true);
  assert.deepEqual([...dispatch.inputNames], ["memo", "create_release_tag"]);

  const pushOnly = parseWorkflowDispatchContract("on:\n  push:\n    branches: [main]\n");
  assert.equal(pushOnly.dispatchable, false);
  assert.deepEqual([...pushOnly.inputNames], []);
});
