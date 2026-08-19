import assert from "node:assert/strict";
import test from "node:test";
import { MARKET_WORKFLOW, isDeployAllWorkflow } from "@/lib/core/deploy-targets";

test("deploy-all 판별은 표시 이름이 아니라 dispatch 대상 워크플로 파일을 본다", () => {
  assert.equal(isDeployAllWorkflow(".github/workflows/deploy-all.yml"), true);
  assert.equal(isDeployAllWorkflow(MARKET_WORKFLOW.ALL), true);
  // 마켓 단독 caller 는 자체 workflow_run 으로 ReleaseRecord 가 파생되므로 제외한다.
  assert.equal(isDeployAllWorkflow(".github/workflows/deploy-google-play.yml"), false);
  assert.equal(isDeployAllWorkflow(".github/workflows/deploy-apps-in-toss.yml"), false);
  assert.equal(isDeployAllWorkflow(null), false);
  assert.equal(isDeployAllWorkflow(undefined), false);
});
