import assert from "node:assert/strict";
import test from "node:test";
import {
  recordDeployAllRun,
  type DeployAllReleaseDeps,
  type DeployAllRunContext,
  type MarketReleaseInput,
} from "@/lib/sync/deploy-all-release";
import type { DeployAllRunJob } from "@/lib/core/deploy-all-jobs";

const DEPLOY_ALL = `
jobs:
  resolve:
    name: Resolve release tag
    runs-on: seorilabs-rpi-arm64
  ait:
    name: Deploy AIT
    uses: ./.github/workflows/deploy-apps-in-toss.yml
  google-play:
    name: Deploy Google Play
    uses: ./.github/workflows/deploy-google-play.yml
  app-store:
    name: Deploy App Store
    uses: ./.github/workflows/deploy-app-store.yml
`;

const UPDATED_AT = new Date("2026-08-27T00:10:36.000Z");

function context(overrides: Partial<DeployAllRunContext> = {}): DeployAllRunContext {
  return {
    repoFullName: "seorilabs/happy-farm",
    appId: "app_happy_farm",
    workflowName: "Deploy All",
    headSha: "2a2711bfba57d8ed5bd45a71986a029991d06b89",
    version: "v1.10.3",
    status: "SUCCEEDED",
    runId: 33028376820n,
    runAttempt: 1,
    runUrl: "https://github.com/seorilabs/happy-farm/actions/runs/33028376820",
    ghUpdatedAt: UPDATED_AT,
    ...overrides,
  };
}

interface Recorded {
  releases: MarketReleaseInput[];
  runCards: Array<{ text: string; eventKey: string; occurredAt: Date }>;
}

function deps(
  overrides: Partial<DeployAllReleaseDeps> = {},
  jobs: DeployAllRunJob[] = [],
): { deps: DeployAllReleaseDeps; recorded: Recorded } {
  const recorded: Recorded = { releases: [], runCards: [] };
  return {
    recorded,
    deps: {
      readWorkflowFile: async () => DEPLOY_ALL,
      listRunJobs: async () => jobs,
      recordMarketRelease: async (input) => {
        recorded.releases.push(input);
      },
      appDisplayName: async () => "행복 농장 타이쿤",
      enqueueRunResultCard: async (input) => {
        recorded.runCards.push(input);
      },
      ...overrides,
    },
  };
}

test("성공한 마켓마다 단일 마켓 배포와 같은 배포 기록을 남긴다", async () => {
  const { deps: d, recorded } = deps({}, [
    { name: "Resolve release tag", conclusion: "success" },
    { name: "Deploy AIT / AIT artifact deploy", conclusion: "success" },
    { name: "Deploy Google Play / Upload AAB to Google Play internal track", conclusion: "success" },
    { name: "Deploy App Store", conclusion: "skipped" },
  ]);
  const results = await recordDeployAllRun(context(), d);

  assert.deepEqual(results.map((r) => r.market), ["AIT", "PLAY"]);
  assert.deepEqual(recorded.releases.map((r) => [r.market, r.status, r.workflowName]), [
    ["AIT", "SUCCEEDED", "Deploy All / Deploy AIT"],
    ["PLAY", "SUCCEEDED", "Deploy All / Deploy Google Play"],
  ]);
  // 마켓 카드를 남겼으면 실행 단위 카드는 중복이므로 보내지 않는다.
  assert.deepEqual(recorded.runCards, []);
  // 실행되지 않은 App Store 는 배포 기록 자체가 없다.
  assert.equal(recorded.releases.some((r) => r.market === "APPSTORE"), false);
  // 승격은 deploy-all 이 하지 않으므로 stable 태그의 track 은 비운다.
  assert.deepEqual(recorded.releases.map((r) => r.track), [null, null]);
  assert.deepEqual(recorded.releases.map((r) => [r.runId, r.runAttempt, r.version]), [
    [33028376820n, 1, "v1.10.3"],
    [33028376820n, 1, "v1.10.3"],
  ]);
});

test("한 마켓이 실패해도 나머지 마켓의 성공 기록은 남는다", async () => {
  const { deps: d, recorded } = deps({}, [
    { name: "Deploy Google Play / Signed Android App Bundle", conclusion: "failure" },
    { name: "Deploy AIT / AIT artifact deploy", conclusion: "success" },
    { name: "Deploy App Store", conclusion: "skipped" },
  ]);
  await recordDeployAllRun(context({ status: "FAILED" }), d);
  assert.deepEqual(recorded.releases.map((r) => [r.market, r.status]), [
    ["AIT", "SUCCEEDED"],
    ["PLAY", "FAILED"],
  ]);
  assert.deepEqual(recorded.runCards, []);
});

test("마켓 잡이 하나도 돌지 않았으면 실행 단위 카드로 물러선다", async () => {
  const { deps: d, recorded } = deps({}, [
    { name: "Resolve release tag", conclusion: "failure" },
  ]);
  const results = await recordDeployAllRun(context({ status: "FAILED" }), d);

  assert.deepEqual(results, []);
  assert.deepEqual(recorded.releases, []);
  assert.equal(recorded.runCards.length, 1);
  assert.equal(recorded.runCards[0].eventKey, "33028376820:1");
  assert.equal(recorded.runCards[0].occurredAt, UPDATED_AT);
  assert.match(recorded.runCards[0].text, /행복 농장 타이쿤 v1\.10\.3 · 전체 마켓 배포/);
});

test("워크플로 정의를 읽지 못하면 실행 단위 카드로 물러선다", async () => {
  const { deps: d, recorded } = deps(
    {
      readWorkflowFile: async () => {
        throw new Error("Not Found");
      },
    },
    [{ name: "Deploy Google Play / upload", conclusion: "success" }],
  );
  const results = await recordDeployAllRun(context(), d);

  assert.deepEqual(results, []);
  assert.deepEqual(recorded.releases, []);
  assert.equal(recorded.runCards.length, 1);
  assert.match(recorded.runCards[0].text, /전체 마켓 배포/);
});

test("잡 목록을 읽지 못해도 ALL 배포가 무음으로 끝나지 않는다", async () => {
  const { deps: d, recorded } = deps({
    listRunJobs: async () => {
      throw new Error("HTTP 502");
    },
  });
  const results = await recordDeployAllRun(context(), d);

  assert.deepEqual(results, []);
  assert.deepEqual(recorded.releases, []);
  assert.equal(recorded.runCards.length, 1);
});

test("폴백 카드는 앱 표시 이름을 못 읽으면 repo 이름으로 남긴다", async () => {
  const { deps: d, recorded } = deps({ appDisplayName: async () => null });
  await recordDeployAllRun(context(), d);
  assert.match(recorded.runCards[0].text, /seorilabs\/happy-farm v1\.10\.3/);
});

test("snapshot 후보 배포는 Play 내부 트랙으로 기록한다", async () => {
  const { deps: d, recorded } = deps({}, [
    { name: "Deploy Google Play / upload", conclusion: "success" },
  ]);
  await recordDeployAllRun(context({ version: "v1.10.4-snapshot.2" }), d);
  assert.deepEqual(recorded.releases.map((r) => [r.market, r.track]), [["PLAY", "internal"]]);
});
