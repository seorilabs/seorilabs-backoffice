import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import {
  findTagRefId,
  isXcodeCloudRepo,
  matchesManualTagStartCondition,
  selectWorkflowForRepository,
  shouldUseXcodeCloudForTarget,
  waitForTagRefId,
  type WorkflowCandidate,
} from "./dispatch";

const KEY = "XCODE_CLOUD_APP_STORE_REPOS";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

test("allowlist(CSV) 에 있는 repo 는 Xcode Cloud 대상", () => {
  process.env[KEY] = "seorilabs/happy-farm, seorilabs/foo";
  assert.equal(isXcodeCloudRepo("seorilabs/happy-farm"), true);
  assert.equal(isXcodeCloudRepo("seorilabs/foo"), true);
});

test("allowlist 에 없는 repo 는 대상 아님", () => {
  process.env[KEY] = "seorilabs/happy-farm";
  assert.equal(isXcodeCloudRepo("seorilabs/other"), false);
});

test("미설정/빈 allowlist 는 전부 대상 아님", () => {
  delete process.env[KEY];
  assert.equal(isXcodeCloudRepo("seorilabs/happy-farm"), false);
  process.env[KEY] = "";
  assert.equal(isXcodeCloudRepo("seorilabs/happy-farm"), false);
});

test("두 워커의 Xcode Cloud allowlist 가 서로 어긋나지 않는다", () => {
  // 웹/스케줄러는 deployment.yaml, Discord 명령 워커는 discord-workers.yaml 을 쓴다.
  // 한쪽만 갱신하면 같은 repo 가 경로에 따라 GH 와 Xcode Cloud 로 갈린다.
  const pick = (file: string) =>
    readFileSync(new URL(file, import.meta.url), "utf8")
      .match(/XCODE_CLOUD_APP_STORE_REPOS,?\s*value: "([^"]+)"/)?.[1];
  const web = pick("../../../k8s/deployment.yaml");
  const worker = pick("../../../k8s/discord-workers.yaml");
  assert.ok(web && worker);
  assert.deepEqual(web.split(","), worker.split(","));
});

test("Xcode Cloud 제품이 준비된 repo 만 allowlist 에 있다", () => {
  const allowlist = readFileSync(
    new URL("../../../k8s/deployment.yaml", import.meta.url),
    "utf8",
  ).match(/- name: XCODE_CLOUD_APP_STORE_REPOS\s*\n\s*value: "([^"]+)"/)?.[1];
  assert.ok(allowlist);
  const repos = allowlist.split(",");
  // 제품이 없는 repo 를 넣으면 App Store 배포가 "Xcode Cloud 제품 없음" 으로 죽는다.
  for (const repo of ["seorilabs/match-picture-app", "seorilabs/lucid-reversi"]) {
    assert.equal(repos.includes(repo), false, `${repo} 는 Xcode Cloud 제품 미생성`);
  }
  assert.equal(repos.includes("seorilabs/spiritgate-defenders"), true);
});

test("운영 Xcode Cloud allowlist 에 Jomul이 등록됨", () => {
  const deployment = readFileSync(
    new URL("../../../k8s/deployment.yaml", import.meta.url),
    "utf8",
  );
  const allowlist = deployment.match(
    /- name: XCODE_CLOUD_APP_STORE_REPOS\s*\n\s*value: "([^"]+)"/,
  )?.[1];
  assert.ok(allowlist);
  assert.equal(allowlist.split(",").includes("seorilabs/jomul"), true);
  process.env[KEY] = allowlist;

  assert.equal(shouldUseXcodeCloudForTarget("seorilabs/jomul", "APPSTORE"), true);
  assert.equal(shouldUseXcodeCloudForTarget("seorilabs/jomul", "ALL"), true);
  assert.equal(shouldUseXcodeCloudForTarget("seorilabs/jomul", "PLAY"), false);
});

test("운영 Xcode Cloud allowlist 에 운글 저장소가 등록됨", () => {
  const deployment = readFileSync(
    new URL("../../../k8s/deployment.yaml", import.meta.url),
    "utf8",
  );
  const allowlist = deployment.match(
    /- name: XCODE_CLOUD_APP_STORE_REPOS\s*\n\s*value: "([^"]+)"/,
  )?.[1];
  assert.ok(allowlist);
  assert.equal(allowlist.split(",").includes("seorilabs/saju-reader"), true);
  process.env[KEY] = allowlist;
  assert.equal(isXcodeCloudRepo("seorilabs/saju-reader"), true);
});

test("운영 Xcode Cloud allowlist 에 Reascend 저장소가 등록됨", () => {
  const deployment = readFileSync(
    new URL("../../../k8s/deployment.yaml", import.meta.url),
    "utf8",
  );
  const allowlist = deployment.match(
    /- name: XCODE_CLOUD_APP_STORE_REPOS\s*\n\s*value: "([^"]+)"/,
  )?.[1];
  assert.ok(allowlist);
  assert.equal(allowlist.split(",").includes("seorilabs/reascend"), true);
  process.env[KEY] = allowlist;
  assert.equal(shouldUseXcodeCloudForTarget("seorilabs/reascend", "APPSTORE"), true);
  assert.equal(shouldUseXcodeCloudForTarget("seorilabs/reascend", "ALL"), true);
  assert.equal(shouldUseXcodeCloudForTarget("seorilabs/reascend", "PLAY"), false);
});

const cycleRelease: WorkflowCandidate = {
  id: "cycle-release",
  name: "Cycle Pair Release",
  repoFullName: "seorilabs/cycle-pair",
  repositoryId: "cycle-pair-repository",
  isEnabled: true,
  actions: [
    {
      actionType: "ARCHIVE",
      platform: "IOS",
      buildDistributionAudience: "APP_STORE_ELIGIBLE",
    },
  ],
  manualTagStartCondition: {
    source: {
      isAllMatch: false,
      patterns: [{ pattern: "v", isPrefix: true }],
    },
  },
};

test("수동 태그 시작 조건은 all/exact/prefix를 대소문자 구분해 판정", () => {
  assert.deepEqual(
    matchesManualTagStartCondition({ source: { isAllMatch: true } }, "anything"),
    true,
  );
  assert.deepEqual(
    matchesManualTagStartCondition({
      source: {
        isAllMatch: false,
        patterns: [{ pattern: "v0.1.0", isPrefix: false }],
      },
    }, "v0.1.0"),
    true,
  );
  assert.equal(
    matchesManualTagStartCondition({
      source: {
        isAllMatch: false,
        patterns: [{ pattern: "v", isPrefix: true }],
      },
    }, "v0.1.0-snapshot.1"),
    true,
  );
  assert.equal(
    matchesManualTagStartCondition({
      source: {
        isAllMatch: false,
        patterns: [{ pattern: "v", isPrefix: true }],
      },
    }, "V0.1.0"),
    false,
  );
  assert.equal(matchesManualTagStartCondition(null, "v0.1.0"), false);
});

test("같은 제품의 교차 앱 workflow를 제외하고 요청 repo workflow만 선택", () => {
  const lizardWorkflow: WorkflowCandidate = {
    ...cycleRelease,
    id: "lizard-release",
    name: "Lizard Tycoon TestFlight",
    repoFullName: "seorilabs/lizard-tycoon",
    repositoryId: "lizard-tycoon-repository",
  };
  assert.deepEqual(
    selectWorkflowForRepository(
      [lizardWorkflow, cycleRelease],
      "seorilabs/cycle-pair",
      "v0.1.0-snapshot.1",
    ),
    {
      workflowId: "cycle-release",
      repositoryId: "cycle-pair-repository",
    },
  );
});

test("repo가 다르거나 App Store Archive가 아니면 임의 실행하지 않음", () => {
  assert.throws(
    () =>
      selectWorkflowForRepository(
        [
          { ...cycleRelease, repoFullName: "seorilabs/lizard-tycoon" },
          {
            ...cycleRelease,
            id: "development-archive",
            actions: [
              {
                actionType: "ARCHIVE",
                platform: "IOS",
                buildDistributionAudience: null,
              },
            ],
          },
        ],
        "seorilabs/cycle-pair",
        "v0.1.0",
      ),
    /workflow 선택 실패/,
  );
});

test("동일 repo의 배포 workflow가 둘이면 모호성을 실패 처리", () => {
  assert.throws(
    () =>
      selectWorkflowForRepository(
        [cycleRelease, { ...cycleRelease, id: "cycle-release-2" }],
        "seorilabs/cycle-pair",
        "v0.1.0",
      ),
    /일치=2/,
  );
});

test("자동 태그 조건만 있거나 수동 조건이 요청 태그와 다르면 선택하지 않음", () => {
  assert.throws(
    () => selectWorkflowForRepository(
      [{ ...cycleRelease, manualTagStartCondition: null }],
      "seorilabs/cycle-pair",
      "v0.1.0-snapshot.1",
    ),
    /수동 태그 조건 일치=0/,
  );
  assert.throws(
    () => selectWorkflowForRepository(
      [{
        ...cycleRelease,
        manualTagStartCondition: {
          source: {
            isAllMatch: false,
            patterns: [{ pattern: "release/", isPrefix: true }],
          },
        },
      }],
      "seorilabs/cycle-pair",
      "v0.1.0",
    ),
    /수동 태그 조건 일치=0/,
  );
});

test("workflow repository id가 없으면 태그 ref를 임의 repository에서 찾지 않음", () => {
  assert.throws(
    () => selectWorkflowForRepository(
      [{ ...cycleRelease, repositoryId: null }],
      "seorilabs/cycle-pair",
      "v0.1.0-snapshot.1",
    ),
    /workflow repository ID 없음/,
  );
});

test("같은 repo workflow 중 요청 태그를 허용하는 하나만 선택", () => {
  const stableOnly = {
    ...cycleRelease,
    id: "stable-only",
    manualTagStartCondition: {
      source: {
        isAllMatch: false,
        patterns: [{ pattern: "v0.1.0", isPrefix: false }],
      },
    },
  };
  assert.deepEqual(
    selectWorkflowForRepository(
      [stableOnly, cycleRelease],
      "seorilabs/cycle-pair",
      "v0.1.0-snapshot.1",
    ),
    {
      workflowId: "cycle-release",
      repositoryId: "cycle-pair-repository",
    },
  );
});

test("정확한 TAG 이름의 ref id를 찾음", () => {
  assert.equal(
    findTagRefId(
      [
        { id: "branch", attributes: { kind: "BRANCH", name: "v0.0.2" } },
        { id: "other-tag", attributes: { kind: "TAG", name: "v0.0.1" } },
        { id: "target-tag", attributes: { kind: "TAG", name: "v0.0.2" } },
      ],
      "v0.0.2",
    ),
    "target-tag",
  );
});

test("Xcode Cloud 태그 ref 동기화 지연을 재시도", async () => {
  let loads = 0;
  const refId = await waitForTagRefId(
    "v0.0.2",
    async () => {
      loads += 1;
      return loads < 3
        ? []
        : [{ id: "synced-tag", attributes: { kind: "TAG", name: "v0.0.2" } }];
    },
    { delaysMs: [0, 0, 0] },
  );

  assert.equal(refId, "synced-tag");
  assert.equal(loads, 3);
});

test("재시도 후에도 태그 ref가 없으면 운영 확인 항목을 안내", async () => {
  await assert.rejects(
    () => waitForTagRefId("v0.0.2", async () => [], { delaysMs: [0, 0] }),
    /Manual Tag 시작 조건.*SCM 연결 상태/,
  );
});
