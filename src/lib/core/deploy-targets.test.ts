import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKET_WORKFLOW,
  isDeployAllWorkflow,
  isPromoteGooglePlayWorkflow,
  marketFromWorkflowPath,
} from "@/lib/core/deploy-targets";

test("deploy-all 판별은 표시 이름이 아니라 dispatch 대상 워크플로 파일을 본다", () => {
  assert.equal(isDeployAllWorkflow(".github/workflows/deploy-all.yml"), true);
  assert.equal(isDeployAllWorkflow(MARKET_WORKFLOW.ALL), true);
  // 마켓 단독 caller 는 자체 workflow_run 으로 ReleaseRecord 가 파생되므로 제외한다.
  assert.equal(isDeployAllWorkflow(".github/workflows/deploy-google-play.yml"), false);
  assert.equal(isDeployAllWorkflow(".github/workflows/deploy-apps-in-toss.yml"), false);
  assert.equal(isDeployAllWorkflow(null), false);
  assert.equal(isDeployAllWorkflow(undefined), false);
});

test("승격 실행은 파일명으로 판별한다", () => {
  assert.equal(isPromoteGooglePlayWorkflow(".github/workflows/promote-google-play.yml"), true);
  assert.equal(isPromoteGooglePlayWorkflow(".github/workflows/deploy-google-play.yml"), false);
  assert.equal(isPromoteGooglePlayWorkflow(null), false);
});

test("마켓 판별은 표준 caller 워크플로 파일명을 따르고 승격도 PLAY 로 본다", () => {
  // 승격 워크플로의 표시 이름이 repo 마다 달라도 PLAY 배포 기록이 파생돼야
  // 카드가 승격 중복 노출을 막을 수 있다.
  assert.equal(marketFromWorkflowPath(".github/workflows/promote-google-play.yml"), "PLAY");
  assert.equal(marketFromWorkflowPath(".github/workflows/deploy-google-play.yml"), "PLAY");
  assert.equal(marketFromWorkflowPath(".github/workflows/deploy-apps-in-toss.yml"), "AIT");
  assert.equal(marketFromWorkflowPath(".github/workflows/deploy-app-store.yml"), "APPSTORE");
  // deploy-all 은 단일 마켓이 아니라 오케스트레이터다.
  assert.equal(marketFromWorkflowPath(".github/workflows/deploy-all.yml"), null);
  assert.equal(marketFromWorkflowPath(".github/workflows/godot-checks.yml"), null);
  assert.equal(marketFromWorkflowPath(null), null);
});
