import assert from "node:assert/strict";
import test from "node:test";
import {
  deployAllMarketResults,
  parseDeployAllMarketJobs,
} from "@/lib/core/deploy-all-jobs";

const DEPLOY_ALL = `
name: Deploy All
on:
  workflow_dispatch:
    inputs:
      release_tag:
        type: string
jobs:
  resolve:
    name: Resolve release tag
    runs-on: seorilabs-rpi-arm64
    steps:
      - uses: actions/checkout@v7
  ait:
    name: Deploy AIT
    needs: resolve
    uses: ./.github/workflows/deploy-apps-in-toss.yml
  google-play:
    name: Deploy Google Play
    needs: resolve
    uses: ./.github/workflows/deploy-google-play.yml
  app-store:
    name: Deploy App Store
    needs: resolve
    uses: ./.github/workflows/deploy-app-store.yml
`;

test("마켓 판별은 표시 이름이 아니라 uses 대상 워크플로 파일로 한다", () => {
  assert.deepEqual(parseDeployAllMarketJobs(DEPLOY_ALL), [
    { displayName: "Deploy AIT", market: "AIT" },
    { displayName: "Deploy Google Play", market: "PLAY" },
    { displayName: "Deploy App Store", market: "APPSTORE" },
  ]);
});

test("표시 이름을 생략한 잡은 잡 키가 그대로 실행 잡 접두사가 된다", () => {
  const text = `
jobs:
  google-play:
    uses: ./.github/workflows/deploy-google-play.yml
  app-store:
    uses: ./.github/workflows/deploy-app-store.yml
`;
  assert.deepEqual(parseDeployAllMarketJobs(text), [
    { displayName: "google-play", market: "PLAY" },
    { displayName: "app-store", market: "APPSTORE" },
  ]);
});

test("마켓 배포가 아닌 잡과 잘못된 정의는 무시한다", () => {
  assert.deepEqual(parseDeployAllMarketJobs("jobs:\n  build:\n    uses: ./.github/workflows/ci.yml\n"), []);
  assert.deepEqual(parseDeployAllMarketJobs("name: Deploy All\n"), []);
  assert.deepEqual(parseDeployAllMarketJobs(""), []);
});

test("재사용 워크플로 잡은 caller 표시 이름 접두사로 마켓에 귀속된다", () => {
  const results = deployAllMarketResults(parseDeployAllMarketJobs(DEPLOY_ALL), [
    { name: "Resolve release tag", conclusion: "success" },
    { name: "Deploy AIT / AIT artifact deploy", conclusion: "success" },
    { name: "Deploy Google Play / Cloud Build signed Android App Bundle", conclusion: "success" },
    { name: "Deploy Google Play / Upload AAB to Google Play internal track", conclusion: "success" },
    { name: "Deploy App Store", conclusion: "skipped" },
  ]);
  assert.deepEqual(results, [
    { displayName: "Deploy AIT", market: "AIT", status: "SUCCEEDED" },
    { displayName: "Deploy Google Play", market: "PLAY", status: "SUCCEEDED" },
  ]);
});

test("한 마켓의 잡이 실패하면 그 마켓만 실패로 남고 나머지는 성공을 유지한다", () => {
  const results = deployAllMarketResults(parseDeployAllMarketJobs(DEPLOY_ALL), [
    { name: "Resolve release tag", conclusion: "success" },
    { name: "Deploy Google Play / Signed Android App Bundle", conclusion: "failure" },
    { name: "Deploy AIT / AIT artifact deploy", conclusion: "success" },
    { name: "Deploy App Store", conclusion: "skipped" },
  ]);
  assert.deepEqual(results, [
    { displayName: "Deploy AIT", market: "AIT", status: "SUCCEEDED" },
    { displayName: "Deploy Google Play", market: "PLAY", status: "FAILED" },
  ]);
});

test("취소·시간초과도 실패로 수렴하고 실행되지 않은 마켓은 기록하지 않는다", () => {
  const definitions = parseDeployAllMarketJobs(DEPLOY_ALL);
  assert.deepEqual(
    deployAllMarketResults(definitions, [
      { name: "Deploy AIT / AIT artifact deploy", conclusion: "cancelled" },
      { name: "Deploy Google Play / build", conclusion: null },
    ]),
    [
      { displayName: "Deploy AIT", market: "AIT", status: "FAILED" },
      { displayName: "Deploy Google Play", market: "PLAY", status: "FAILED" },
    ],
  );
  // resolve 단계에서 끊겨 마켓 잡이 하나도 없으면 마켓 기록 자체가 없다.
  assert.deepEqual(
    deployAllMarketResults(definitions, [{ name: "Resolve release tag", conclusion: "failure" }]),
    [],
  );
});

test("표시 이름이 다른 잡을 접두사로 잘못 흡수하지 않는다", () => {
  const definitions = [{ displayName: "Deploy App Store", market: "APPSTORE" as const }];
  assert.deepEqual(
    deployAllMarketResults(definitions, [
      { name: "Deploy App Store Extra / upload", conclusion: "failure" },
    ]),
    [],
  );
});
